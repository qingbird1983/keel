import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type AuthPolicyInput } from "../src/authorizer.js";
import { Budgeter } from "../src/budget.js";
import { ModelGateway, type ModelUpstream } from "../src/gateway.js";
import { Ledger } from "../src/ledger.js";
import type { RunRef } from "../src/events.js";

let dir: string;
const ledgers: Ledger[] = [];
const ref: RunRef = { agentId: "agent-1", sessionId: "sess-1", runId: "run-1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-gw-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const upstreamOk: ModelUpstream = {
  invoke: vi.fn(async () => ({ result: { text: "hi" }, usage: { tokens: 7 }, cost: 3 })),
};

function harness(upstream: ModelUpstream = upstreamOk, policy: AuthPolicyInput = policyAllowModel) {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  const auth = new Authorizer(policy, ledger);
  const budget = new Budgeter(ledger);
  return { ledger, auth, budget, gateway: new ModelGateway({ ledger, auth, budget, upstream }) };
}

const policyAllowModel: AuthPolicyInput = {
  version: "p1",
  allow: [{ subject: "cell-1", action: "model.invoke", resource: "model-x" }],
};

const req = { reqId: "req-1", model: "model-x", params: { q: "hi" }, estimate: 5 };

describe("ModelGateway（契约 §4.7 / ADR-0003 / 验收 A7）", () => {
  it("全链路：授权 → 预扣 → 代理 → 实结，MODEL_INVOKED/MODEL_USAGE 入账，差额退还", async () => {
    const { ledger, budget, gateway } = harness();
    const r = await gateway.invoke(ref, "cell-1", req);
    expect(r).toEqual({ result: { text: "hi" }, usage: { tokens: 7 }, cost: 3, replay: false });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.map((e) => e.type)).toEqual([
      "BUDGET_RESERVED",
      "MODEL_INVOKED",
      "BUDGET_SETTLED",
      "MODEL_USAGE",
    ]);
    expect(evs[0].payload).toMatchObject({ reqId: "req-1", estimate: 5 });
    // 实结 3、预扣 5 → 退还 2
    expect(evs.find((e) => e.type === "BUDGET_SETTLED")!.payload).toMatchObject({
      actual: 3,
      refund: 2,
    });
    // 权威记账：used = 实结值
    expect(budget.query(ref).run.used).toBe(3);
  });

  it("fail-closed：无匹配策略 → AUTH/DENIED（必留痕），不预扣、不打上游", async () => {
    const { ledger, auth, budget, gateway } = harness(upstreamOk, {
      version: "p0",
      allow: [],
    });
    await expect(gateway.invoke(ref, "cell-1", req)).rejects.toMatchObject({
      code: "AUTH/DENIED",
    });
    expect(vi.mocked(upstreamOk.invoke)).not.toHaveBeenCalled();
    expect(budget.query(ref).run.used).toBe(0);
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("AUTH_DENIED");
    expect(auth.version).toBe("p0");
  });

  it("预算耗尽：BUDGET/EXHAUSTED（含处置模式），无 MODEL_INVOKED、无 reservation 留痕", async () => {
    const { ledger, budget, gateway } = harness();
    budget.configure({ agentId: ref.agentId, sessionId: ref.sessionId }, { run: 2 });
    await expect(gateway.invoke(ref, "cell-1", req)).rejects.toMatchObject({
      code: "BUDGET/EXHAUSTED",
      detail: { level: "run", mode: "hard-stop" },
    });
    // 预扣前即拒绝：本 run 无任何账本事件（run 目录不存在 = 寻址失败语义）
    await expect(ledger.read({ runId: ref.runId })).rejects.toMatchObject({
      code: "LEDGER/CURSOR-INVALID",
    });
  });

  it("上游失败：settle(0) 全额退还 → GATEWAY/UPSTREAM-ERROR；重试派生新 reservation 并实结", async () => {
    const failing: ModelUpstream = {
      invoke: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ result: "ok", usage: {}, cost: 1 }),
    };
    const { ledger, budget, gateway } = harness(failing);
    await expect(gateway.invoke(ref, "cell-1", req)).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
    });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.find((e) => e.type === "BUDGET_SETTLED")!.payload).toMatchObject({
      actual: 0,
      refund: 5,
    });
    // 重试同 reqId：新 reservation（settle-once 语义），上游再打一次，实结真实用量
    const r2 = await gateway.invoke(ref, "cell-1", req);
    expect(r2).toMatchObject({ result: "ok", replay: false });
    expect(vi.mocked(failing.invoke)).toHaveBeenCalledTimes(2);
    expect(budget.query(ref).run.used).toBe(1);
    const evs2 = (await ledger.read({ runId: ref.runId })).events;
    expect(evs2.filter((e) => e.type === "BUDGET_RESERVED").map((e) => e.payload)).toMatchObject([
      { reqId: "req-1" },
      { reqId: "req-1#2" },
    ]);
    expect(evs2.filter((e) => e.type === "BUDGET_SETTLED")).toHaveLength(2);
  });

  it("同 reqId 已实结重放：replay=true，不重打上游、不重复计费（A7 权威记账）", async () => {
    const { ledger, budget, gateway } = harness();
    await gateway.invoke(ref, "cell-1", req);
    const r2 = await gateway.invoke(ref, "cell-1", { ...req, estimate: 999 });
    expect(r2.replay).toBe(true);
    expect(budget.query(ref).run.used).toBe(3);
    expect(budget.query(ref).session.used).toBe(3);
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.filter((e) => e.type === "MODEL_INVOKED")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "BUDGET_RESERVED")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "MODEL_USAGE")).toHaveLength(1);
    expect(vi.mocked(upstreamOk.invoke)).toHaveBeenCalledTimes(1);
  });
});
