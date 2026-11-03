/**
 * 策略舱面单测（切片④ 回填项 ①，ADR-0012 决策 1/2/3）。
 *
 * 断言只围三件事：
 * 1. **装载期形状校验**：`export const hooks` 的键集必须与报关单声明**完全相等**——
 *    少了是"报关与实现两张皮"，多了是"没申领就插话"（#14 要挡的那一支）；
 * 2. **舱只应答被登记的插话点**：没登记的名字明确拒绝（`CELL/ACTION-UNKNOWN`），
 *    不静默走默认值——默认策略是**内核**的语义（HookBus），不是舱的；
 * 3. **就绪凭据仍是一次既有应答**（`cell.snapshot`），策略方向不为就绪新增 op。
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FrameConn, startCell } from "../src/index.js";
import { normalizePolicyHooks, PolicyLoadRefused } from "../src/policy-hooks.js";

function rig() {
  const hostToCell = new PassThrough();
  const cellToHost = new PassThrough();
  const cell = startCell({
    input: hostToCell,
    output: cellToHost,
    toolCallTimeoutMs: 0, // 策略舱不受理 tool.exec（唯一时限在宿主/内核那两处）
    loadGate: true,
  });
  const core = new FrameConn({ input: cellToHost, output: hostToCell });
  return { cell, core };
}

describe("normalizePolicyHooks：导出集合必须等于声明集合", () => {
  const fn = async () => ({ verdict: "approve" });

  it("ESM 命名导出与 CJS（default 上挂 hooks）两种形状都认", () => {
    expect(normalizePolicyHooks({ hooks: { toolApproval: fn } }, ["toolApproval"])).toEqual({
      toolApproval: fn,
    });
    expect(
      normalizePolicyHooks({ default: { hooks: { stopAdvice: fn } } }, ["stopAdvice"]).stopAdvice,
    ).toBe(fn);
  });

  it("声明两个、导出两个：逐名登记（顺序无关）", () => {
    const map = normalizePolicyHooks({ hooks: { stopAdvice: fn, toolApproval: fn } }, [
      "toolApproval",
      "stopAdvice",
    ]);
    expect(Object.keys(map).sort()).toEqual(["stopAdvice", "toolApproval"]);
  });

  it('没有 hooks 导出 → 装载期拒（策略插件不持有别的接口，也没有"猜第一个函数"这条路）', () => {
    expect(() =>
      normalizePolicyHooks({ default: function activate() {} }, ["toolApproval"]),
    ).toThrowError(PolicyLoadRefused);
    expect(() => normalizePolicyHooks({}, ["toolApproval"])).toThrowError(/no "hooks" export/);
  });

  it("空表 / 非函数值 / 非对象 → 装载期拒", () => {
    expect(() => normalizePolicyHooks({ hooks: {} }, ["toolApproval"])).toThrowError(/empty table/);
    expect(() =>
      normalizePolicyHooks({ hooks: { toolApproval: "yes" } }, ["toolApproval"]),
    ).toThrowError(/must be a function/);
    expect(() => normalizePolicyHooks({ hooks: [fn] }, ["toolApproval"])).toThrowError(
      /plain object/,
    );
  });

  it("声明了却没导出 → 拒，并点名 missing（两张皮不起舱）", () => {
    expect(() =>
      normalizePolicyHooks({ hooks: { toolApproval: fn } }, ["toolApproval", "retryAdvice"]),
    ).toThrowError(/missing=\["retryAdvice"\]/);
  });

  it("导出了却没声明 → 拒，并点名 undeclared（#14 变相接管在这里就断掉）", () => {
    expect(() =>
      normalizePolicyHooks({ hooks: { toolApproval: fn, stopAdvice: fn } }, ["toolApproval"]),
    ).toThrowError(/undeclared=\["stopAdvice"\]/);
  });
});

describe("startCell 的 policy.hook 路由（被动面）", () => {
  it("按登记的名字调用处理体，verdict 原样回给宿主；入参只有 input", async () => {
    const { cell, core } = rig();
    const seen: unknown[] = [];
    cell.setHooks({
      toolApproval: async (input) => {
        seen.push(input);
        return { verdict: "deny", reason: "not allowed" };
      },
    });
    cell.markReady();
    const reply = await core.request(
      "policy.hook",
      { hook: "toolApproval", round: 1, input: { tool: "x" } },
      500,
    );
    expect(reply).toEqual({ verdict: "deny", reason: "not allowed" });
    // round 是内核记账用的，不混进插件可见的入参（策略只看见 hook 入参）
    expect(seen).toEqual([{ tool: "x" }]);
  });

  it("未登记的插话点明确拒绝（CELL/ACTION-UNKNOWN），不静默返回默认策略", async () => {
    const { cell, core } = rig();
    cell.setHooks({ toolApproval: async () => ({ verdict: "approve" }) });
    cell.markReady();
    await expect(
      core.request("policy.hook", { hook: "stopAdvice", input: {} }, 500),
    ).rejects.toMatchObject({ code: "CELL/ACTION-UNKNOWN" });
  });

  it("处理体抛错 → 帧层报错（宿主侧因此走内核既有 fallback，而不是舱内兜底）", async () => {
    const { cell, core } = rig();
    cell.setHooks({
      retryAdvice: async () => {
        throw new Error("policy exploded");
      },
    });
    cell.markReady();
    await expect(
      core.request("policy.hook", { hook: "retryAdvice", input: {} }, 500),
    ).rejects.toBeDefined();
  });

  it("装载门生效：markReady 之前不应答，之后一次 cell.snapshot 得到 {state:null} 即就绪凭据", async () => {
    const { cell, core } = rig();
    cell.setHooks({ toolApproval: async () => ({ verdict: "approve" }) });
    const pending = core.request("policy.hook", { hook: "toolApproval", input: {} }, 120);
    await expect(pending).rejects.toMatchObject({ code: "TRANSPORT/TIMEOUT" }); // 门未开：排队不应答
    cell.markReady();
    expect(await core.request("cell.snapshot", {}, 500)).toEqual({ state: null });
  });
});
