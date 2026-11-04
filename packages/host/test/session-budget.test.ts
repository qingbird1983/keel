import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budgeter, Ledger, SessionReader } from "@keel/core";
import { projectSessionBudget } from "../src/session/budget.js";

let dir: string;
let ledger: Ledger;
const scope = { agentId: "agent-a", sessionId: "sess-1" };
const run1 = { ...scope, runId: "run-1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-session-budget-"));
  ledger = new Ledger({ rootDir: dir });
});

afterEach(async () => {
  await ledger.close();
  await rm(dir, { recursive: true, force: true });
});

async function readAll() {
  const reader = new SessionReader(ledger);
  const events = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await reader.read(scope, {}, cursor);
    events.push(...page.events);
    if (!page.nextCursor) return events;
    cursor = page.nextCursor;
  }
}

describe("会话预算投影（Phase 5 R7）", () => {
  it("= 已结算 actual + 未结算 reservation.estimate（崩溃漏账的保守上界）", async () => {
    const b = new Budgeter(ledger);
    b.configure(scope, { run: 1_000, session: 1_000 });
    const r1 = await b.reserve(run1, "req-1", 2);
    await b.settle(run1, r1.reservationId, 1.5);
    await b.reserve(run1, "req-2", 0.5); // 有预扣、无结算（模拟崩溃）
    const events = await readAll();
    expect(projectSessionBudget(events)).toBeCloseTo(2.0, 10);
  });

  it("新实例回填后跨进程不归零：session 限额继续生效", async () => {
    const first = new Budgeter(ledger);
    first.configure(scope, { run: 1_000, session: 5 });
    const r = await first.reserve(run1, "req-1", 3);
    await first.settle(run1, r.reservationId, 3);

    const second = new Budgeter(ledger);
    second.seedSessionUsage(scope, projectSessionBudget(await readAll()));
    second.configure(scope, { run: 1_000, session: 5 });
    const run2 = { ...scope, runId: "run-2" };
    const r2 = await second.reserve(run2, "req-2", 2); // 3 + 2 = 5，刚好用满
    await second.settle(run2, r2.reservationId, 2);
    await expect(second.reserve(run2, "req-3", 1)).rejects.toMatchObject({
      code: "BUDGET/EXHAUSTED",
    });
  });

  it("回填幂等：重复 seed 不累加", async () => {
    const b = new Budgeter(ledger);
    b.seedSessionUsage(scope, 3);
    b.seedSessionUsage(scope, 100);
    b.configure(scope, { session: 4, run: 1_000 });
    const run2 = { ...scope, runId: "run-2" };
    await expect(b.reserve(run2, "req-x", 2)).rejects.toMatchObject({
      code: "BUDGET/EXHAUSTED",
    });
    await expect(b.reserve(run2, "req-y", 1)).resolves.toBeDefined();
  });
});
