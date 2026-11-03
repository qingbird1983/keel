/**
 * 集成测试（真实子进程）—— Phase 2 验收 **B7①**：策略插件经装配链接进真实 run，四个白名单 hook
 * 逐条介入且**可归因**，且策略进程的死亡不级联到 run（合同 §5 B7①；06 稿 §3.1 / §4）。
 *
 * 与 Phase 1 A6 的差别就是这一段回填项本身（报告 §3 第 3 条登记的限制）：那时策略插话由
 * **内核注册面**（`HookBus.register`）在测试里直接接进来；这里的 handler 背后是一个
 * **独立的 OS 进程**装载的策略模块（ADR-0012），插话要跨一次 stdio 往返。于是"策略只能插话、
 * 不能接管"第一次有了真进程凭据：
 * - hook① 的否决真的挡住了动作（被挡的那次连 handler 都没进去——靠 sink 文件里少一行来证）；
 * - hook② 的建议真的收束了 run，但终态事件是内核写的；
 * - hook③ 的重试建议受内核钳制（≤3 次、退避 ≤30s）：策略要 1 小时退避也没用；
 * - hook④ 的耗尽选择只能在 Core 给定的两个选项里选，选完的终态仍由内核落；
 * - 每条介入都进了本 run 的 `DECISION.basedOn`（V6 归因锚），装配审计里也点得出绑了谁（ADR-0012 决策 6）。
 *
 * 材料性质：策略样本与工具样本都是合成的（01 稿 §5 的证据表述纪律）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEvent, ModelUpstream } from "@keel/core";
import type { PolicySpec } from "@keel/host";
import {
  createLegacyRig,
  fixtureFile,
  legacyManifest,
  policyFor,
  policySpec,
  type RunProbe,
} from "./fixtures/cordis-rig";

const AGENT = "agent-b7";
const CAPS = [{ cap: "tool.provide" }, { cap: "model.adapter" }];
/** hook④ 的额度面：单轮估算 7，Run 限额 10 → 第二轮必然耗尽。 */
const ESTIMATE = 7;
const UPSTREAM_COST = 7;

let sinkDir = "";
const open: { close(): Promise<void> }[] = [];
const upstream: ModelUpstream = {
  invoke: async () => ({ result: { text: "stub" }, usage: { tokens: 5 }, cost: UPSTREAM_COST }),
};

/** 起一套带**真实策略舱**的 rig（装配期就完成起舱 → 探就绪 → 注册）。 */
async function rigWithPolicy(...policies: PolicySpec[]) {
  const rig = createLegacyRig({ policies, upstream });
  open.push(rig);
  await rig.setup(policyFor(legacyManifest(CAPS), AGENT));
  return rig;
}

async function newSink(label: string): Promise<string> {
  const file = path.join(sinkDir, `${label}.sink`);
  await writeFile(file, "", "utf-8");
  return file;
}

function of(events: LedgerEvent[], type: string): LedgerEvent[] {
  return events.filter((e) => e.type === type);
}

function count(events: LedgerEvent[], type: string): number {
  return of(events, type).length;
}

function pl(e: LedgerEvent): Record<string, unknown> {
  return e.payload as Record<string, unknown>;
}

/** 某个 hook 的 (HOOK_CALLED, HOOK_VERDICT) 序列，按调用次序成对。 */
function hookPairs(events: LedgerEvent[], hook: string) {
  const called = of(events, "HOOK_CALLED").filter((e) => pl(e).hook === hook);
  const verdicts = of(events, "HOOK_VERDICT").filter((e) => pl(e).hook === hook);
  return called.map((c, i) => ({ called: c, verdict: verdicts[i] }));
}

function lastResult(events: LedgerEvent[], tool: string): Record<string, unknown> {
  const hit = of(events, "TOOL_RESULT")
    .reverse()
    .find((e) => pl(e).tool === tool);
  return hit ? pl(hit) : {};
}

/**
 * 归因锚（V6）：这条介入的两个 seq 出现在**之后某一轮**的 DECISION.basedOn 里。
 * 用"存在某轮"而不是"第 N 轮"——装载屏障会吃掉若干空转轮，轮号在真实进程下不是稳定量。
 */
function attributed(events: LedgerEvent[], seqs: number[]): boolean {
  const last = Math.max(...seqs);
  return of(events, "DECISION").some(
    (d) => d.seq > last && seqs.every((s) => (pl(d).basedOn as number[]).includes(s)),
  );
}

beforeEach(async () => {
  sinkDir = await mkdtemp(path.join(tmpdir(), "keel-b7-"));
});

afterEach(async () => {
  await Promise.allSettled(open.map((r) => r.close()));
  open.length = 0;
  await rm(sinkDir, { recursive: true, force: true });
});

describe("B7① hook①：审批否决真的挡住动作", () => {
  it("策略 deny 的 transfer 没进 handler，放行的 mark 照常；介入进了下一轮的决策依据", async () => {
    const rig = await rigWithPolicy(policySpec("deny-transfer.mjs", ["toolApproval"]));
    const sink = await newSink("deny");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-1a",
      runId: "run-hook1",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      plan: [
        { visible: ["mark", "transfer", "flaky"], call: { tool: "mark", params: { sink } } },
        { call: { tool: "transfer", params: { sink, amount: 7 } } },
        { done: true },
      ],
    });
    const status = await probe.done;
    expect(status.state).toBe("halted");
    expect(probe.violations).toEqual([]);

    const events = await rig.readRun("run-hook1");
    expect(lastResult(events, "transfer")).toMatchObject({
      status: "error",
      error: { code: "AUTH/DENIED", by: "policy-hook" },
    });
    // 账本之外的那一半凭据：被挡的那次连 handler 都没进去
    expect((await readFile(sink, "utf-8")).trim().split("\n")).toEqual(["mark"]);

    const pairs = hookPairs(events, "toolApproval");
    expect(pairs).toHaveLength(2); // 两次工具动作 = 两次介入（没申领别的 hook 就不被问）
    expect(pl(pairs[1].verdict).verdict).toEqual({
      verdict: "deny",
      reason: "policy: transfers need a human",
    });
    expect(pairs.every((p) => pl(p.verdict).fallback === false)).toBe(true);
    // 归因锚：第 1 轮的介入出现在之后某轮 DECISION.basedOn 里（V6）
    for (const p of pairs) expect(attributed(events, [p.called.seq, p.verdict.seq])).toBe(true);
    // 没申领的插话点一次都没被调用（无介入即无事件）
    expect(count(events, "HOOK_CALLED")).toBe(2);
    for (const hook of ["stopAdvice", "retryAdvice", "budgetExhaustedChoice"]) {
      expect(of(events, "HOOK_CALLED").filter((e) => pl(e).hook === hook)).toEqual([]);
    }
  });

  it("装配审计点得出绑了谁：ASSEMBLY_RECORDED.policies（ADR-0012 决策 6）", async () => {
    const rig = await rigWithPolicy(policySpec("deny-transfer.mjs", ["toolApproval"]));
    const sink = await newSink("audit");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-1b",
      runId: "run-audit",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      plan: [{ visible: ["mark"], call: { tool: "mark", params: { sink } } }, { done: true }],
    });
    await probe.done;
    const events = await rig.readRun("run-audit");
    expect(events[0].type).toBe("ASSEMBLY_RECORDED");
    expect(pl(events[0]).policies).toEqual([
      { name: "policy-deny-transfer", version: "1.0.0", hooks: ["toolApproval"] },
    ]);
  });

  it("没有策略时不写这个字段：旧账本形状保持不变（追加字段而非改写）", async () => {
    const rig = createLegacyRig({ upstream });
    open.push(rig);
    await rig.setup(policyFor(legacyManifest(CAPS), AGENT));
    const sink = await newSink("nopolicy");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-1c",
      runId: "run-nopolicy",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      plan: [{ visible: ["mark"], call: { tool: "mark", params: { sink } } }, { done: true }],
    });
    await probe.done;
    const events = await rig.readRun("run-nopolicy");
    expect("policies" in pl(events[0])).toBe(false);
    expect(count(events, "HOOK_CALLED")).toBe(0); // 没绑 = 没人说话，也不留痕
  });
});

describe("B7① hook②/③：建议与重试都在内核的边界内", () => {
  it("策略按决策摘要建议收束 → 在途动作照常执行完，终态由内核写 RUN_HALTED{stop-advised}", async () => {
    const rig = await rigWithPolicy(policySpec("stop-on-marker.mjs", ["stopAdvice"]));
    const sink = await newSink("stop");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-2a",
      runId: "run-hook2",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      plan: [
        { visible: ["mark"], label: "steady", call: { tool: "mark", params: { sink } } },
        // 这一轮的摘要里带 policy-stop：建议发生在本轮动作之前，但**在途动作照常执行完**才收束
        { label: "policy-stop", call: { tool: "mark", params: { sink } } },
        // 到不了的一轮：建议被采纳，run 在这里就收束了
        { call: { tool: "mark", params: { sink } } },
      ],
    });
    const status = await probe.done;
    expect(status.state).toBe("halted");
    expect((await readFile(sink, "utf-8")).trim().split("\n")).toEqual(["mark", "mark"]);

    const events = await rig.readRun("run-hook2");
    const pairs = hookPairs(events, "stopAdvice");
    // 前两轮各一次介入（装载屏障的空转轮摘要里没有标记，所以不会被建议打断）
    expect(pairs.length).toBeGreaterThanOrEqual(3);
    expect(pl(pairs[0].verdict).verdict).toEqual({ suggestStop: false });
    expect(pairs.map((p) => pl(p.verdict).verdict.suggestStop)).toContain(true);
    const halted = of(events, "RUN_HALTED")[0];
    expect(pl(halted).reason).toBe("stop-advised");
    // 归因：被打断的那条建议之前，介入都已进过决策依据
    expect(attributed(events, [pairs[0].called.seq, pairs[0].verdict.seq])).toBe(true);
  });

  it("策略永远建议重试 → 次数与退避都由内核钳：4 次调用、30s 上限（契约 §7）", async () => {
    const rig = await rigWithPolicy(policySpec("retry-forever.mjs", ["retryAdvice"]));
    const sink = await newSink("retry");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-3a",
      runId: "run-hook3",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      plan: [{ visible: ["flaky"], call: { tool: "flaky", params: { sink } } }, { done: true }],
    });
    const status = await probe.done;
    expect(status.state).toBe("halted"); // 工具失败 ≠ run 失败

    const events = await rig.readRun("run-hook3");
    expect(of(events, "TOOL_INVOKE").filter((e) => pl(e).tool === "flaky")).toHaveLength(4); // 1 + 3
    expect((await readFile(sink, "utf-8").then((t) => t.trim())).split("\n")).toHaveLength(4);
    const pairs = hookPairs(events, "retryAdvice");
    expect(pairs).toHaveLength(4);
    // 策略要的是 3_600_000ms；内核钳到 30_000ms——**每一次**都被钳（注入的 delay 缝记的就是请求值）
    expect(rig.retryDelays).toEqual([30_000, 30_000, 30_000]);
    expect(pairs.every((p) => pl(p.verdict).fallback === false)).toBe(true);
    expect(pairs[0].called.seq).toBeLessThan(pairs[0].verdict.seq);
  });
});

describe("B7① hook④：耗尽处置由策略在 Core 给定的选项里选", () => {
  const budgetPlan = (sink: string) => [
    {
      visible: ["mark"],
      model: { reqId: "q1", model: "gpt-stub", estimate: ESTIMATE, params: { sink } },
    },
    { model: { reqId: "q2", model: "gpt-stub", estimate: ESTIMATE, params: { sink } } },
    { done: true },
  ];

  it("绑了选 graceful 的策略 → RUN_HALTED（在途轮收干净），且这条介入真的被采纳", async () => {
    const rig = await rigWithPolicy(policySpec("choose-graceful.mjs", ["budgetExhaustedChoice"]));
    const sink = await newSink("budget-policy");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-4a",
      runId: "run-hook4",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      budgetLimits: { run: 10, onRunExhausted: "policy" },
      plan: budgetPlan(sink),
    });
    const status = await probe.done;
    expect(status.state).toBe("halted");
    expect(status.reasonCode).toBe("BUDGET/EXHAUSTED-GRACEFUL");

    const events = await rig.readRun("run-hook4");
    const pairs = hookPairs(events, "budgetExhaustedChoice");
    expect(pairs).toHaveLength(1);
    expect(pl(pairs[0].verdict).verdict).toEqual({ action: "graceful" });
    expect(pl(pairs[0].verdict).fallback).toBe(false);
    // 轮号不做绝对断言（装载屏障会吃掉空转轮）：这条介入就是本 run 的最后一次插话
    expect(pairs).toHaveLength(1);
    expect(pl(pairs[0].called).round).toBe(pl(pairs[0].verdict).round);
    // 第 1 轮的钱真花了（预扣+实结），第 2 轮在预扣处被拦：没有 MODEL_INVOKED 也没有重复计费
    expect(count(events, "MODEL_INVOKED")).toBe(1);
    expect(count(events, "BUDGET_RESERVED")).toBe(1);
    expect(count(events, "BUDGET_SETTLED")).toBe(1);
    expect(of(events, "RUN_HALTED").length).toBe(1);
    // 这一条没有"下一轮的 DECISION"可归因（run 就停在这里）——用序关系表达同一件事
    expect(pairs[0].verdict.seq).toBeLessThan(of(events, "RUN_HALTED")[0].seq);
  });

  it("同样的额度、没绑策略 → 默认 hardStop：RUN_FAILED（策略改变的是选择，不是事实源）", async () => {
    const rig = createLegacyRig({ upstream });
    open.push(rig);
    await rig.setup(policyFor(legacyManifest(CAPS), AGENT));
    const sink = await newSink("budget-nopolicy");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-4b",
      runId: "run-hook4-none",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      budgetLimits: { run: 10, onRunExhausted: "policy" },
      plan: budgetPlan(sink),
    });
    const status = await probe.done;
    expect(status.state).toBe("failed");
    expect(status.reasonCode).toBe("BUDGET/EXHAUSTED");
    const events = await rig.readRun("run-hook4-none");
    // policy 档但没注册 hook④：内核不调用也不留痕，直接走 fallback 的硬停
    expect(count(events, "HOOK_CALLED")).toBe(0);
    expect(count(events, "RUN_FAILED")).toBe(1);
  });
});

describe("B7① 边界：策略进程的死与不全", () => {
  it("策略舱半途中死 → 后续插话一律 fallback，run 正常收束且能力舱不受影响（I2）", async () => {
    const rig = await rigWithPolicy(policySpec("deny-transfer.mjs", ["toolApproval"]));
    const sink = await newSink("crash");
    const killPolicy = async () => {
      await rig.policies[0].cell.drainAndReap();
    };
    const probe: RunProbe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-5a",
      runId: "run-crash",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      plan: [
        { visible: ["mark", "transfer"], call: { tool: "mark", params: { sink } } },
        // 第 2 轮：决策之前先收掉策略舱，本轮的动作因此打在"没有策略可问"的状态上
        { before: killPolicy, call: { tool: "transfer", params: { sink, amount: 3 } } },
        { done: true },
      ],
    });
    const status = await probe.done;
    expect(status.state).toBe("halted"); // 不是 failed：策略死了不该带走 run
    const events = await rig.readRun("run-crash");
    expect(count(events, "RUN_FAILED")).toBe(0);
    expect(of(events, "RUN_HALTED").length).toBe(1);
    // 舱死了之后的那次插话：默认策略（不否决）→ transfer 这次**放行**了，且落了 fallback 留痕
    const fallbacks = of(events, "HOOK_VERDICT").filter((e) => pl(e).fallback === true);
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
    expect(lastResult(events, "transfer").status).toBe("ok");
    expect((await readFile(sink, "utf-8")).trim().split("\n")).toEqual(["mark", "transfer"]);
    // 能力舱还活着（策略舱的退出没有级联）
    expect(["ready", "running"].includes(probe.cell.phase)).toBe(true);
  });

  it("导出集合 ≠ 报关集合（多申领）→ 装载期拒，起舱即失败：不接「能用的那几个」", async () => {
    const rig = createLegacyRig({
      policies: [policySpec("undeclared-extra.mjs", ["toolApproval"])],
      upstream,
    });
    open.push(rig);
    const err = await rig.setup(policyFor(legacyManifest(CAPS), AGENT)).catch((e: unknown) => e);
    expect(err).toMatchObject({ detail: { reason: "CELL_NOT_READY" } });
    // 封闭集合内的两个码都可能：策略进程先退就报通道断，探测先到期就报超时——
    // 两者都是"未得到应答"，都不新增错误码（ADR-0012 决策 4）
    expect(["TRANSPORT/TIMEOUT", "TRANSPORT/BADFRAME"]).toContain((err as { code: string }).code);
    expect(rig.policies).toEqual([]); // 没有半活的绑定留给调用方
  });
});
