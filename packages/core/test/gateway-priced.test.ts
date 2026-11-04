import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Authorizer } from "../src/authorizer.js";
import { Budgeter } from "../src/budget.js";
import { ModelGateway, type ModelUpstream } from "../src/gateway.js";
import { Ledger } from "../src/ledger.js";
import type { RunRef } from "../src/events.js";
import type { ModelPricing } from "../src/pricing.js";

let dir: string;
const ledgers: Ledger[] = [];
const ref: RunRef = { agentId: "agent-priced", sessionId: "sess-priced", runId: "run-priced" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-gw-priced-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const pricing: ModelPricing = {
  unit: "usd_per_mtok",
  offPeak: { inputCached: 0.1, inputUncached: 0.2, output: 0.4 },
  peak: { inputCached: 0.2, inputUncached: 0.4, output: 0.8 },
  peakWindows: [{ days: "mon-fri", utc: "01:00-04:00" }],
};
const buckets = { inputCached: 1_000_000, inputUncached: 1_000_000, output: 1_000_000 };
const policy = {
  version: "p-priced",
  // 资源通配：本组测的是"注册面"而不是授权矩阵（授权矩阵由既有 A7 用例守）
  allow: [{ subject: "cell-1", action: "model.invoke", resource: "*" }],
};

function harness(
  upstream: ModelUpstream = { invoke: async () => ({ result: {}, usage: buckets }) },
  now: () => number = () => Date.parse("2026-11-04T12:00:00Z"),
  invokeTimeoutMs?: number,
) {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  const auth = new Authorizer(policy, ledger);
  const budget = new Budgeter(ledger);
  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream,
    now,
    ...(invokeTimeoutMs !== undefined ? { invokeTimeoutMs } : {}),
  });
  return { ledger, budget, gateway };
}

async function events(ledger: Ledger) {
  return (await ledger.read({ runId: ref.runId })).events;
}

const req = { reqId: "req-1", model: "model-x", params: {}, estimate: 5 };

describe("ModelGateway · manifest 计价路径（Phase 4 切片③ R4/R5）", () => {
  it("模块只报三桶 → Core 按时钟判峰谷计价，MODEL_USAGE 带桶/档/来源", async () => {
    const { ledger, budget, gateway } = harness();
    gateway.registerModel({
      models: ["model-x"],
      upstream: { invoke: async () => ({ result: { text: "hi" }, usage: buckets }) },
      pricing,
    });
    const r = await gateway.invoke(ref, "cell-1", req);
    expect(r).toMatchObject({ cost: 0.7, usage: buckets, replay: false });
    expect(budget.query(ref).run.used).toBe(0.7);
    const evs = await events(ledger);
    const usage = evs.find((e) => e.type === "MODEL_USAGE")!;
    expect(usage.schemaVersion).toBe(3);
    expect(usage.payload).toEqual({
      reqId: "req-1",
      usage: buckets,
      cost: 0.7,
      usageBuckets: buckets,
      tier: "offPeak",
      pricedBy: "manifest",
    });
    expect(evs.find((e) => e.type === "BUDGET_SETTLED")!.payload).toMatchObject({
      actual: 0.7,
      refund: 4.3,
    });
  });

  it("模块自报 cost = 协议违规：拒绝、全额退还、不写 MODEL_USAGE", async () => {
    const { ledger, budget, gateway } = harness();
    gateway.registerModel({
      models: ["model-x"],
      upstream: {
        invoke: async () => ({ result: {}, usage: buckets, cost: 9 }),
      } as ModelUpstream,
      pricing,
    });
    await expect(gateway.invoke(ref, "cell-1", req)).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "UPSTREAM_PROVIDED_COST" },
    });
    expect(budget.query(ref).run.used).toBe(0);
    const evs = await events(ledger);
    expect(evs.map((e) => e.type)).toEqual(["BUDGET_RESERVED", "MODEL_INVOKED", "BUDGET_SETTLED"]);
  });

  it("未注册模型一律拒绝（不回落宿主演示桩）", async () => {
    const { ledger, gateway } = harness();
    gateway.registerModel({
      models: ["model-x"],
      upstream: { invoke: async () => ({ result: {}, usage: buckets }) },
      pricing,
    });
    await expect(
      gateway.invoke(ref, "cell-1", { ...req, model: "other-model" }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "MODEL_NOT_REGISTERED" },
    });
    // 未注册 = 预扣之前就拒，账本里连 BUDGET_RESERVED 都不该有
    await expect(ledger.read({ runId: ref.runId })).rejects.toMatchObject({
      code: "LEDGER/CURSOR-INVALID",
    });
  });

  it("用量不按桶报 = 显式失败，不按 0 记账", async () => {
    const { ledger, budget, gateway } = harness();
    gateway.registerModel({
      models: ["model-x"],
      upstream: { invoke: async () => ({ result: {}, usage: { tokens: 7 } }) },
      pricing,
    });
    await expect(gateway.invoke(ref, "cell-1", req)).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "UPSTREAM_USAGE_INVALID" },
    });
    expect(budget.query(ref).run.used).toBe(0);
    expect((await events(ledger)).map((e) => e.type)).not.toContain("MODEL_USAGE");
  });

  it("非流式总时限到点 = 上游失败：先全额退还，再报 INVOKE_TIMEOUT", async () => {
    const { ledger, budget, gateway } = harness(
      {
        invoke: () =>
          new Promise((resolve) => {
            const t = setTimeout(() => resolve({ result: {}, usage: buckets, cost: 0 }), 200);
            t.unref?.();
          }),
      },
      () => Date.now(),
      10,
    );
    gateway.registerModel({
      models: ["model-x"],
      upstream: {
        invoke: () =>
          new Promise((resolve) => {
            const t = setTimeout(() => resolve({ result: {}, usage: buckets, cost: 0 }), 200);
            t.unref?.();
          }),
      },
      pricing,
    });
    await expect(gateway.invoke(ref, "cell-1", req)).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "INVOKE_TIMEOUT" },
    });
    expect(budget.query(ref).run.used).toBe(0);
    expect((await events(ledger)).map((e) => e.type)).not.toContain("MODEL_USAGE");
  });
});
