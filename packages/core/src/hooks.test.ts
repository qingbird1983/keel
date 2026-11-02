import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookBus } from "./hooks.js";
import { Ledger } from "./ledger.js";
import type { RunRef } from "./events.js";

let dir: string;
const ledgers: Ledger[] = [];
const ref: RunRef = { agentId: "agent-1", sessionId: "sess-1", runId: "run-1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-hooks-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

function harness(opts?: ConstructorParameters<typeof HookBus>[1]) {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  return { ledger, hooks: new HookBus(ledger, { timeoutMs: 30, ...opts }) };
}

async function eventsOf(ledger: Ledger) {
  return (await ledger.read({ runId: ref.runId })).events;
}

describe("HookBus（契约 §4.8 白名单四件套）", () => {
  it("未注册的 hook：不调用不留痕，直接返回默认策略", async () => {
    const { ledger, hooks } = harness();
    const res = await hooks.call(ref, "toolApproval", 1, { tool: "t" });
    expect(res).toEqual({ verdict: { verdict: "approve" }, fallback: true, seqs: [] });
    await expect(eventsOf(ledger)).rejects.toMatchObject({ code: "LEDGER/CURSOR-INVALID" });
  });

  it("注册后正常裁决：verdict 生效且 HOOK_CALLED/HOOK_VERDICT 双留痕（fallback=false）", async () => {
    const { ledger, hooks } = harness();
    hooks.register("toolApproval", async () => ({ verdict: "deny", reason: "not allowed" }));
    const res = await hooks.call(ref, "toolApproval", 3, { tool: "t" });
    expect(res.verdict).toEqual({ verdict: "deny", reason: "not allowed" });
    expect(res.fallback).toBe(false);
    const evs = await eventsOf(ledger);
    expect(evs.map((e) => e.type)).toEqual(["HOOK_CALLED", "HOOK_VERDICT"]);
    expect(evs[0].payload).toEqual({ hook: "toolApproval", round: 3 });
    expect(evs[1].payload).toEqual({
      hook: "toolApproval",
      round: 3,
      verdict: { verdict: "deny", reason: "not allowed" },
      fallback: false,
    });
    expect(res.seqs).toEqual(evs.map((e) => e.seq));
  });

  it("V6 禁区：响应含白名单外字段（tool/params/下一动作类）→ schema 拒绝回落默认", async () => {
    const { hooks } = harness();
    hooks.register("toolApproval", async () => ({
      verdict: "deny",
      tool: "other-tool",
      params: { inject: true },
    }));
    const res = await hooks.call(ref, "toolApproval", 1, {});
    expect(res.verdict).toEqual({ verdict: "approve" }); // 默认策略
    expect(res.fallback).toBe(true);
  });

  it("stopAdvice：合法建议放行；非法类型回落", async () => {
    const { hooks } = harness();
    hooks.register("stopAdvice", async () => ({ suggestStop: true, reason: "goal met" }));
    expect((await hooks.call(ref, "stopAdvice", 1, {})).verdict).toEqual({
      suggestStop: true,
      reason: "goal met",
    });
    hooks.register("stopAdvice", async () => ({ suggestStop: "yes" }));
    const bad = await hooks.call(ref, "stopAdvice", 2, {});
    expect(bad.verdict).toEqual({ suggestStop: false });
    expect(bad.fallback).toBe(true);
  });

  it("retryAdvice：非法 backoffMs / 非法字段回落 give-up", async () => {
    const { hooks } = harness();
    hooks.register("retryAdvice", async () => ({ policy: "retry", backoffMs: 5 }));
    expect((await hooks.call(ref, "retryAdvice", 1, {})).verdict).toEqual({
      policy: "retry",
      backoffMs: 5,
    });
    hooks.register("retryAdvice", async () => ({ policy: "retry", backoffMs: "soon" }));
    const bad = await hooks.call(ref, "retryAdvice", 2, {});
    expect(bad.verdict).toEqual({ policy: "give-up" });
    expect(bad.fallback).toBe(true);
  });

  it("budgetExhaustedChoice：action 是给定选项（合法）；额外字段被拒", async () => {
    const { hooks } = harness();
    hooks.register("budgetExhaustedChoice", async () => ({ action: "graceful" }));
    expect((await hooks.call(ref, "budgetExhaustedChoice", 1, {})).verdict).toEqual({
      action: "graceful",
    });
    hooks.register("budgetExhaustedChoice", async () => ({ action: "graceful", next: "run" }));
    const bad = await hooks.call(ref, "budgetExhaustedChoice", 2, {});
    expect(bad.verdict).toEqual({ action: "hardStop" });
    expect(bad.fallback).toBe(true);
  });

  it("handler 抛异常 → 默认策略 + fallback:true 留痕", async () => {
    const { hooks } = harness();
    hooks.register("toolApproval", async () => {
      throw new Error("plugin bug");
    });
    const res = await hooks.call(ref, "toolApproval", 1, {});
    expect(res.fallback).toBe(true);
    expect(res.verdict).toEqual({ verdict: "approve" });
  });

  it("handler 超时 → 默认策略 + HOOK_VERDICT{fallback:true}（契约 §4.8）", async () => {
    const { ledger, hooks } = harness();
    hooks.register("toolApproval", () => new Promise(() => undefined)); // 永不返回
    const res = await hooks.call(ref, "toolApproval", 1, {});
    expect(res.fallback).toBe(true);
    const evs = await eventsOf(ledger);
    expect(evs.at(-1)).toMatchObject({ type: "HOOK_VERDICT", payload: { fallback: true } });
  });

  it("超时窗口可注入（测试用）", async () => {
    const { hooks } = harness({ timeoutMs: 5 });
    hooks.register(
      "stopAdvice",
      () => new Promise((r) => setTimeout(() => r({ suggestStop: false }), 3)),
    );
    const res = await hooks.call(ref, "stopAdvice", 1, {});
    expect(res.fallback).toBe(false);
  });
});
