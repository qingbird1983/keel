import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type AuthPolicyInput } from "./authorizer.js";
import { Budgeter } from "./budget.js";
import { ContextManager } from "./context.js";
import { HookBus } from "./hooks.js";
import { ModelGateway } from "./gateway.js";
import { Scheduler } from "./scheduler.js";
import type { DriverAction, DriverDecision, RunManifest } from "./scheduler.js";
import { Ledger } from "./ledger.js";
import type { DecisionPayload, EventType, LedgerEvent, RunRef } from "./events.js";

let dir: string;
const ledgers: Ledger[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-sched-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const POLICY: AuthPolicyInput = {
  version: "p1",
  allow: [
    { subject: "cell-1", action: "tool.invoke", resource: "*" },
    { subject: "cell-1", action: "model.invoke", resource: "*" },
  ],
};

function harness(opts?: { policy?: AuthPolicyInput; maxConcurrentRuns?: number }) {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  const auth = new Authorizer(opts?.policy ?? POLICY, ledger);
  const budget = new Budgeter(ledger);
  const ctx = new ContextManager();
  const hooks = new HookBus(ledger, { timeoutMs: 30 });
  const upstream = { invoke: async () => ({ result: "m", usage: {}, cost: 2 }) };
  const gateway = new ModelGateway({ ledger, auth, budget, upstream });
  const delays: number[] = [];
  const scheduler = new Scheduler(
    { ledger, auth, budget, ctx, hooks, gateway },
    {
      maxConcurrentRuns: opts?.maxConcurrentRuns,
      delay: async (ms) => void delays.push(ms),
    },
  );
  const scope = { agentId: "agent-1", sessionId: "sess-1" };
  ctx.alloc(scope);
  ctx.registerTool(scope, { name: "t1", schemaVersion: 1, schema: {} });
  return { ledger, budget, ctx, hooks, scheduler, delays, ref: { ...scope, runId: "run-1" } };
}

function manifest(
  ref: RunRef,
  driver: ReturnType<typeof scriptedDriver>,
  extra?: Partial<RunManifest>,
): RunManifest {
  return {
    ref,
    subject: "cell-1",
    executor: async () => ({ status: "ok", result: "done" }),
    driver,
    ...extra,
  };
}

function scriptedDriver(rounds: DriverDecision[]) {
  let i = 0;
  return {
    decide: async (): Promise<DriverDecision> =>
      rounds[i++] ?? { done: true, summary: "auto-done" },
  };
}

async function typesOf(ledger: Ledger, runId: string): Promise<EventType[]> {
  return (await ledger.read({ runId })).events.map((e) => e.type);
}

const TOOL: DriverAction = { kind: "tool", tool: "t1", params: { x: 1 } };
const MODEL: DriverAction = {
  kind: "model",
  reqId: "req-1",
  model: "model-x",
  params: {},
  estimate: 5,
};

describe("Scheduler（契约 §4.1 轮循环）", () => {
  it("正常两轮：事件序列符合固定轮序，CHECKPOINT 先于 ROUND_ENDED，终态 halted/completed", async () => {
    const { ledger, scheduler, ref } = harness();
    const driver = scriptedDriver([
      { summary: "r1", actions: [TOOL] },
      { done: true, summary: "r2" },
    ]);
    const { done } = scheduler.start(manifest(ref, driver));
    const status = await done;
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "ROUND_STARTED",
      "TOOL_SCHEMA_CHANGED", // 装配期注册 t1 的挂起变更在轮 1 入账
      "DECISION",
      "TOOL_INVOKE",
      "TOOL_RESULT",
      "CHECKPOINT",
      "ROUND_ENDED",
      "ROUND_STARTED",
      "DECISION",
      "CHECKPOINT",
      "ROUND_ENDED",
      "RUN_HALTED",
    ]);
    expect(evs.at(-1)!.payload).toEqual({ reason: "completed" });
    // DECISION basedOn = 决策前已写事件 seq（V6 归因锚）
    const d1 = evs.find((e) => e.type === "DECISION") as LedgerEvent & {
      payload: DecisionPayload;
    };
    expect(d1.payload.basedOn).toEqual(evs.slice(0, 3).map((e) => e.seq));
    // 每个 ROUND_ENDED 前必见 CHECKPOINT（同轮）
    for (let i = 0; i < evs.length; i++) {
      if (evs[i].type === "ROUND_ENDED") expect(evs[i - 1].type).toBe("CHECKPOINT");
    }
    expect(status).toMatchObject({ state: "halted", rounds: 2 });
    expect(status.lastCheckpoint).toEqual({ seq: evs[10].seq, round: 2 });
  });

  it("切片②注记：start 前注册的工具 → 轮 1 挂起变更入账（TOOL_SCHEMA_CHANGED）", async () => {
    const { ledger, scheduler, ref, ctx } = harness();
    ctx.registerTool(
      { agentId: ref.agentId, sessionId: ref.sessionId },
      { name: "t2", schemaVersion: 1, schema: {} },
    );
    const { done } = scheduler.start(manifest(ref, scriptedDriver([{ done: true, summary: "" }])));
    await done;
    const evs = (await ledger.read({ runId: ref.runId })).events;
    // 变更日志序 = [t1（harness 装配期）, t2]；轮 1 全部入账
    expect(evs.slice(2, 4).map((e) => e.payload)).toEqual([
      {
        tool: "t1",
        oldSchemaVersion: 0,
        newSchemaVersion: 1,
        affectedScope: { agentId: ref.agentId, sessionId: ref.sessionId },
      },
      {
        tool: "t2",
        oldSchemaVersion: 0,
        newSchemaVersion: 1,
        affectedScope: { agentId: ref.agentId, sessionId: ref.sessionId },
      },
    ]);
  });

  it("Core 侧故障隔离（A2 前置）：driver 崩溃只失败本 run，另一 run 不受影响", async () => {
    const { ledger, scheduler, ref } = harness();
    const badRef = { ...ref, runId: "run-bad" };
    const okRef = { ...ref, runId: "run-ok" };
    const bad = scheduler.start(
      manifest(badRef, {
        decide: async () => {
          throw new Error("plugin crash");
        },
      }),
    );
    const ok = scheduler.start(manifest(okRef, scriptedDriver([{ done: true, summary: "" }])));
    expect((await bad.done).state).toBe("failed");
    expect((await ok.done).state).toBe("halted");
    const badEvs = (await ledger.read({ runId: badRef.runId })).events;
    expect(badEvs.at(-1)).toMatchObject({
      type: "RUN_FAILED",
      payload: { reasonCode: "DRIVER-ERROR" },
    });
    expect(await typesOf(ledger, okRef.runId)).toContain("RUN_HALTED");
  });

  it("hook① 否决：不执行、TOOL_RESULT 落点 AUTH/DENIED(by policy-hook)，run 继续", async () => {
    const { ledger, scheduler, ref, hooks } = harness();
    const exec = vi.fn(async () => ({ status: "ok" as const, result: "" }));
    hooks.register("toolApproval", async () => ({ verdict: "deny", reason: "no" }));
    const driver = scriptedDriver([
      { summary: "", actions: [TOOL] },
      { done: true, summary: "" },
    ]);
    const { done } = scheduler.start(manifest(ref, driver, { executor: exec }));
    await done;
    expect(exec).not.toHaveBeenCalled();
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.find((e) => e.type === "TOOL_RESULT")!.payload).toMatchObject({
      status: "error",
      error: { code: "AUTH/DENIED", by: "policy-hook", reason: "no" },
    });
    expect((await done).state).toBe("halted");
  });

  it("Core 授权拒绝：AUTH_DENIED 留痕 + TOOL_RESULT(by core)，hook③ 不介入（不可重试）", async () => {
    const { ledger, scheduler, ref, hooks } = harness({ policy: { version: "p0", allow: [] } });
    let retryCalls = 0;
    hooks.register("retryAdvice", async () => {
      retryCalls += 1;
      return { policy: "retry" };
    });
    const { done } = scheduler.start(
      manifest(
        ref,
        scriptedDriver([
          { summary: "", actions: [TOOL] },
          { done: true, summary: "" },
        ]),
      ),
    );
    await done;
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.filter((e) => e.type === "AUTH_DENIED")).toHaveLength(1);
    expect(evs.find((e) => e.type === "TOOL_RESULT")!.payload).toMatchObject({
      error: { code: "AUTH/DENIED", by: "core" },
    });
    expect(retryCalls).toBe(0);
  });

  it("hook③ 重试：钳制 ≤3 次、退避 ≤30s；成功即止", async () => {
    const { ledger, scheduler, ref, hooks, delays } = harness();
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      return calls < 3
        ? ({ status: "error", error: { msg: "flaky" } } as const)
        : ({ status: "ok", result: "y" } as const);
    });
    hooks.register("retryAdvice", async () => ({ policy: "retry", backoffMs: 60_000 }));
    const { done } = scheduler.start(
      manifest(
        ref,
        scriptedDriver([
          { summary: "", actions: [TOOL] },
          { done: true, summary: "" },
        ]),
        {
          executor: exec,
        },
      ),
    );
    await done;
    expect(exec).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([30_000, 30_000]); // 钳制：backoffMs 60s → 30s 上限
    const invokes = (await ledger.read({ runId: ref.runId })).events.filter(
      (e) => e.type === "TOOL_INVOKE",
    );
    expect(invokes).toHaveLength(3);
  });

  it("hook③ 重试上限：始终失败 → 1+3 次后放弃，动作失败不终止 run", async () => {
    const { scheduler, ref, hooks } = harness();
    const exec = vi.fn(async () => ({ status: "error" as const, error: { msg: "down" } }));
    hooks.register("retryAdvice", async () => ({ policy: "retry", backoffMs: 0 }));
    const { done } = scheduler.start(
      manifest(
        ref,
        scriptedDriver([
          { summary: "", actions: [TOOL] },
          { done: true, summary: "" },
        ]),
        {
          executor: exec,
        },
      ),
    );
    const status = await done;
    expect(exec).toHaveBeenCalledTimes(4); // 首次 + ≤3 重试
    expect(status).toMatchObject({ state: "halted", rounds: 2 });
  });

  it("模型动作经网关：授权+预算+MODEL_INVOKED/MODEL_USAGE 全链路（A7 集成）", async () => {
    const { ledger, scheduler, ref } = harness();
    const { done } = scheduler.start(
      manifest(
        ref,
        scriptedDriver([
          { summary: "", actions: [MODEL] },
          { done: true, summary: "" },
        ]),
      ),
    );
    await done;
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.map((e) => e.type)).toContain("MODEL_INVOKED");
    expect(evs.map((e) => e.type)).toContain("MODEL_USAGE");
    expect(evs.map((e) => e.type)).toContain("BUDGET_RESERVED");
    expect(evs.map((e) => e.type)).toContain("BUDGET_SETTLED");
  });

  it("耗尽 hard-stop（默认档）：RUN_FAILED + 补偿收尾被调用", async () => {
    const { ledger, budget, scheduler, ref } = harness();
    budget.configure({ agentId: ref.agentId, sessionId: ref.sessionId }, { run: 1 });
    const compensator = vi.fn(async () => undefined);
    const { done } = scheduler.start(
      manifest(ref, scriptedDriver([{ summary: "", actions: [MODEL, TOOL] }]), { compensator }),
    );
    const status = await done;
    expect(status).toMatchObject({ state: "failed", reasonCode: "BUDGET/EXHAUSTED" });
    expect(compensator).toHaveBeenCalledTimes(1);
    const evs = (await ledger.read({ runId: ref.runId })).events;
    // hard-stop：耗尽后本轮剩余动作（TOOL）不再执行
    expect(evs.filter((e) => e.type === "TOOL_INVOKE")).toHaveLength(0);
    expect(evs.at(-1)).toMatchObject({
      type: "RUN_FAILED",
      payload: { reasonCode: "BUDGET/EXHAUSTED" },
    });
  });

  it("耗尽 policy 档 → hook④ 选 graceful：完成在途动作后 RUN_HALTED", async () => {
    const { budget, scheduler, ref, hooks } = harness();
    budget.configure(
      { agentId: ref.agentId, sessionId: ref.sessionId },
      { run: 1, onRunExhausted: "policy" },
    );
    hooks.register("budgetExhaustedChoice", async () => ({ action: "graceful" }));
    const compensator = vi.fn(async () => undefined);
    const { done } = scheduler.start(
      manifest(ref, scriptedDriver([{ summary: "", actions: [MODEL, TOOL] }]), { compensator }),
    );
    const status = await done;
    expect(status).toMatchObject({ state: "halted", reasonCode: "BUDGET/EXHAUSTED-GRACEFUL" });
    expect(compensator).toHaveBeenCalledTimes(1);
  });

  it("耗尽 policy 档 hook④ 缺席 → fallback hardStop（fail-closed）", async () => {
    const { budget, scheduler, ref } = harness();
    budget.configure(
      { agentId: ref.agentId, sessionId: ref.sessionId },
      { run: 1, onRunExhausted: "policy" },
    );
    const { done } = scheduler.start(
      manifest(ref, scriptedDriver([{ summary: "", actions: [MODEL] }])),
    );
    expect(await done).toMatchObject({ state: "failed", reasonCode: "BUDGET/EXHAUSTED" });
  });

  it("hook② stopAdvice 采纳：本轮收束后停（reason=stop-advised）", async () => {
    const { scheduler, ref, hooks, ledger } = harness();
    hooks.register("stopAdvice", async () => ({ suggestStop: true }));
    const { done } = scheduler.start(
      manifest(ref, scriptedDriver([{ summary: "", actions: [TOOL] }, { summary: "never" }])),
    );
    const status = await done;
    expect(status).toMatchObject({ state: "halted", rounds: 1 });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)).toMatchObject({ type: "RUN_HALTED", payload: { reason: "stop-advised" } });
    expect(evs.filter((e) => e.type === "HOOK_VERDICT")).toHaveLength(1);
  });

  it("cancel：停止派发新轮，在途轮正常收束后 RUN_HALTED{reason:cancelled}", async () => {
    const { scheduler, ref, ledger } = harness();
    const exec = vi.fn(async () => {
      void scheduler.cancel(ref.runId); // 在途执行中请求取消（不等待，避免自锁）
      return { status: "ok" as const, result: "" };
    });
    const { done } = scheduler.start(
      manifest(ref, scriptedDriver([{ summary: "", actions: [TOOL] }, { summary: "never" }]), {
        executor: exec,
      }),
    );
    const status = await done;
    expect(status).toMatchObject({ state: "halted", rounds: 1 });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)).toMatchObject({ type: "RUN_HALTED", payload: { reason: "cancelled" } });
    expect(evs.filter((e) => e.type === "ROUND_STARTED")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "CHECKPOINT")).toHaveLength(1);
  });

  it("start 幂等：同 runId 返回既有结果，不重复执行", async () => {
    const { scheduler, ref } = harness();
    const driver = scriptedDriver([{ summary: "", actions: [TOOL] }]);
    const m = manifest(ref, driver);
    const s1 = scheduler.start(m);
    const s2 = scheduler.start(m);
    expect(s2.done).toBe(s1.done);
    await s1.done;
    expect((await s2.done).rounds).toBe(2); // 第二次 start 未重跑（round 2 = driver 自动 done）
  });

  it("准入与寻址错误：MANIFEST-INVALID / BACKPRESSURE / NOT-FOUND", () => {
    const { scheduler, ref } = harness({ maxConcurrentRuns: 0 });
    expect(() =>
      scheduler.start({ ...manifest(ref, scriptedDriver([])), subject: "" }),
    ).toThrowError(expect.objectContaining({ code: "SCHED/MANIFEST-INVALID" }));
    expect(() => scheduler.start(manifest(ref, scriptedDriver([])))).toThrowError(
      expect.objectContaining({ code: "SCHED/BACKPRESSURE" }),
    );
    expect(() => scheduler.status("nope")).toThrowError(
      expect.objectContaining({ code: "SCHED/NOT-FOUND" }),
    );
    return expect(scheduler.cancel("nope")).rejects.toMatchObject({ code: "SCHED/NOT-FOUND" });
  });
});
