import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budgeter } from "./budget.js";
import { KeelError } from "./errors.js";
import { Ledger } from "./ledger.js";
import type { EventType } from "./events.js";

let dir: string;
const ledgers: Ledger[] = [];
const ref = { agentId: "agent-1", sessionId: "sess-1", runId: "run-1" };
const ref2 = { agentId: "agent-1", sessionId: "sess-1", runId: "run-2" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-budget-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

function harness() {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  return { ledger, budget: new Budgeter(ledger) };
}

async function eventTypes(ledger: Ledger, runId: string): Promise<EventType[]> {
  const page = await ledger.read({ runId });
  return page.events.map((e) => e.type);
}

describe("Budgeter（契约 §4.3 / 验收 A7）", () => {
  it("reserve 预扣两级、query 反映两级用量", async () => {
    const { budget } = harness();
    budget.configure({ agentId: "agent-1", sessionId: "sess-1" }, { run: 100, session: 200 });
    await budget.reserve(ref, "req-1", 30);

    const q = budget.query(ref);
    expect(q.run).toEqual({ limit: 100, used: 30, remaining: 70 });
    expect(q.session).toEqual({ limit: 200, used: 30, remaining: 170 });
  });

  it("run 级耗尽 → BUDGET/EXHAUSTED{level:run}，默认处置 hard-stop", async () => {
    const { budget } = harness();
    budget.configure({ agentId: "agent-1", sessionId: "sess-1" }, { run: 50 });
    await budget.reserve(ref, "req-1", 40);
    await expect(budget.reserve(ref, "req-2", 20)).rejects.toSatisfy((e: unknown) => {
      const err = e as KeelError;
      return err.code === "BUDGET/EXHAUSTED" && (err.detail as { level: string }).level === "run";
    });
    expect(budget.query(ref).onRunExhausted).toBe("hard-stop");
  });

  it("session 级耗尽跨 run 生效（scope 链向上预扣），默认处置 graceful", async () => {
    const { budget } = harness();
    budget.configure({ agentId: "agent-1", sessionId: "sess-1" }, { session: 100 });
    await budget.reserve(ref, "req-1", 70);
    await expect(budget.reserve(ref2, "req-2", 40)).rejects.toSatisfy((e: unknown) => {
      const err = e as KeelError;
      return (
        err.code === "BUDGET/EXHAUSTED" && (err.detail as { level: string }).level === "session"
      );
    });
    expect(budget.query(ref2).onSessionExhausted).toBe("graceful");
  });

  it("settle 实结退还差额，两级余量同步回吐（契约 §9：session 余量 = run 结算后回吐）", async () => {
    const { budget } = harness();
    budget.configure({ agentId: "agent-1", sessionId: "sess-1" }, { run: 100, session: 100 });
    const r = await budget.reserve(ref, "req-1", 80);
    expect(budget.query(ref).run.remaining).toBe(20); // 预扣后
    const { refund } = await budget.settle(ref, r.reservationId, 50);
    expect(refund).toBe(30);
    expect(budget.query(ref).run.remaining).toBe(50); // 实结后按实际耗用回吐
    expect(budget.query(ref).session.remaining).toBe(50);
  });

  it("同 reqId 重放返回同一 reservation，不重复计费（A7 锚）", async () => {
    const { budget } = harness();
    budget.configure({ agentId: "agent-1", sessionId: "sess-1" }, { run: 100 });
    const r1 = await budget.reserve(ref, "req-1", 40);
    const r2 = await budget.reserve(ref, "req-1", 40); // 幂等重放
    expect(r2.reservationId).toBe(r1.reservationId);
    expect(budget.query(ref).run.used).toBe(40); // 只扣一次
  });

  it("同 reservation 只结算一次（重复 settle 幂等）", async () => {
    const { ledger, budget } = harness();
    budget.configure({ agentId: "agent-1", sessionId: "sess-1" }, { run: 100 });
    const r = await budget.reserve(ref, "req-1", 80);
    await budget.settle(ref, r.reservationId, 50);
    await budget.settle(ref, r.reservationId, 50); // 重放
    expect(budget.query(ref).run.used).toBe(50);
    const types = await eventTypes(ledger, "run-1");
    expect(types.filter((t) => t === "BUDGET_SETTLED")).toHaveLength(1);
  });

  it("未知 reservation 结算 → BUDGET/RESERVATION-UNKNOWN", async () => {
    const { budget } = harness();
    await expect(budget.settle(ref, "res-nope", 1)).rejects.toMatchObject({
      code: "BUDGET/RESERVATION-UNKNOWN",
    });
  });

  it("configure 校验：负数/非有限限额 → BUDGET/INVALID-LIMIT", () => {
    const { budget } = harness();
    expect(() => budget.configure(ref, { run: -1 })).toThrowError(KeelError);
    expect(() => budget.configure(ref, { session: Number.POSITIVE_INFINITY })).toThrowError(
      KeelError,
    );
  });

  it("预扣与实结均入账本（A6 审计锚）", async () => {
    const { ledger, budget } = harness();
    budget.configure({ agentId: "agent-1", sessionId: "sess-1" }, { run: 100 });
    const r = await budget.reserve(ref, "req-1", 60);
    await budget.settle(ref, r.reservationId, 45);
    expect(await eventTypes(ledger, "run-1")).toEqual(["BUDGET_RESERVED", "BUDGET_SETTLED"]);
  });
});
