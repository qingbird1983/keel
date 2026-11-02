/**
 * 集成测试（真实进程 · 规模级补执行）—— 验收 A6 主张（V6，一票否决）：
 * 任选一个真实 Run，从账本重放它的完整决策序列，逐条核对归因链可复原：
 * ① 序列完整：seq 自 1 连续无缺口（写侧 close 后由冷实例读取）；
 * ② 每次 hook 介入成对留痕（HOOK_CALLED→HOOK_VERDICT 紧邻、fallback=false），
 *    且裁决真实改变走向（①否决 → TOOL_RESULT{AUTH/DENIED, by:policy-hook} 且无 TOOL_INVOKE；
 *    ③建议重试 → 同 reqId 派生预扣后成功，MODEL_USAGE 只落一次）；
 * ③ Core 授权拒绝留痕（AUTH_DENIED 带 subject/action/resource/policyVersion/reason）；
 * ④ 归因锚闭合：DECISION.basedOn 只引用已发生事件，且覆盖上一轮全部 hook 裁决 seq；
 * ⑤ 交付入口可读：`keel replay` 子进程对同一 Run 输出上述全部归因行（逐事件一行）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Authorizer,
  Budgeter,
  ContextManager,
  HookBus,
  Ledger,
  ModelGateway,
  Scheduler,
  type DecisionPayload,
  type HookVerdictPayload,
  type LedgerEvent,
  type RunDriver,
  type RunRef,
  type Scope,
  type ToolResultPayload,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  EffectTracker,
  ProcessIsolationProvider,
  SupervisedCell,
  serveCellChannel,
} from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const cliBin = path.join(repoRoot, "apps", "keel", "dist", "main.js");
const plugin = path.join(repoRoot, "tests", "fixtures", "ok-plugin.mjs");
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

const AGENT = "agent-a6";
const RUN = "run-a6";

/** 白名单刻意只放 ok / risky / gpt-mini：ghost 必须被 Core 拒绝（拒绝留痕是 A6 主张之一）。 */
const policy = {
  version: "p-a6",
  allow: [
    { subject: "*", action: "tool.invoke", resource: "ok" },
    { subject: "*", action: "tool.invoke", resource: "risky" },
    { subject: "*", action: "model.invoke", resource: "gpt-mini" },
  ],
};

const manifest = new Assembler({ schema: manifestSchema }).assemble({
  kind: "capability",
  meta: { name: "a6-demo", version: "1.0.0", title: "A6", description: "归因复演载体" },
  permissions: [{ cap: "tool.provide" }],
  resources: { toolCallTimeoutMs: 10_000 },
  compensation: { templates: [] },
  compat: { keelContract: "^1.0" },
});

/** 五轮剧本：放行 / Core 拒 / hook① 否决 / 模型（首败 → hook③ 重试）/ 收束。 */
const ACTIONS = [
  [{ kind: "tool" as const, tool: "ok", params: { tag: "a6" } }],
  [{ kind: "tool" as const, tool: "ghost", params: {} }],
  [{ kind: "tool" as const, tool: "risky", params: {} }],
  [{ kind: "model" as const, reqId: "m1", model: "gpt-mini", params: { q: 1 }, estimate: 100 }],
];

let dir = "";
let ledger: Ledger;
let cell: SupervisedCell;
const events: LedgerEvent[] = [];
let replayOut = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-a6-"));
  ledger = new Ledger({ rootDir: dir });
  const auth = new Authorizer(policy, ledger);
  const budget = new Budgeter(ledger);
  const ctxMgr = new ContextManager();
  let upstreamCalls = 0;

  const hooks = new HookBus(ledger);
  // hook① 审批：对 risky 行使否决权（只有否决权，Core 授权仍是硬门）
  hooks.register("toolApproval", async (input) => {
    const tool = (input as { tool?: string }).tool;
    return tool === "risky"
      ? { verdict: "deny" as const, reason: "policy: risky is blocked" }
      : { verdict: "approve" as const };
  });
  // hook② 停止建议：每轮都介入并建议继续
  hooks.register("stopAdvice", async () => ({ suggestStop: false, reason: "keep going" }));
  // hook③ 重试建议：首败建议立即重试（退避 0），再败放手
  hooks.register("retryAdvice", async (input) => {
    const attempt = (input as { attempt?: number }).attempt ?? 0;
    return attempt === 0
      ? { policy: "retry" as const, backoffMs: 0 }
      : { policy: "give-up" as const };
  });

  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: {
      invoke: async () => {
        upstreamCalls += 1;
        if (upstreamCalls === 1) throw new Error("simulated upstream 503");
        return { result: { text: "hi" }, usage: { tokens: 12 }, cost: 60 };
      },
    },
  });
  const scheduler = new Scheduler({ ledger, auth, budget, ctx: ctxMgr, hooks, gateway });
  const supervisor = new CellSupervisor({
    provider: new ProcessIsolationProvider(),
    cellEntryPath: cellEntry,
    toolKillGraceMs: 5_000,
    onCellExit: (e) => {
      const ref = e.cell.ref;
      if (ref) void scheduler.abort(ref.runId, e.reasonCode, e.message);
    },
  });

  const scope: Scope = { agentId: AGENT, sessionId: "sess-a6" };
  const ref: RunRef = { ...scope, runId: RUN };
  const tracker = new EffectTracker({ ledger });
  cell = supervisor.spawnCell({ manifest, pluginPath: plugin, tracker });
  serveCellChannel(
    cell.conn,
    {
      scope,
      ref,
      subject: AGENT,
      templates: new Map(manifest.templates.map((t) => [t.kind, t])),
    },
    { ledger, auth, budget, ctx: ctxMgr, gateway, tracker },
  );
  ctxMgr.alloc(scope);
  budget.configure(scope, { run: 1000 });

  const driver: RunDriver = {
    decide: async (c) =>
      c.round > ACTIONS.length
        ? { done: true, summary: "a6-end" }
        : { summary: `a6-r${c.round}`, actions: ACTIONS[c.round - 1] ?? [] },
  };
  const { done } = scheduler.start({
    ref,
    subject: AGENT,
    executor: cell.executor,
    driver,
    assembly: manifest.record,
  });
  cell.attachRun(ref);
  const status = await done;
  expect(status).toMatchObject({ state: "halted", rounds: 5 });
  await cell.drainAndReap();
  await ledger.close(); // 写侧收束：以下读取一律冷实例
});

beforeAll(async () => {
  const cold = new Ledger({ rootDir: dir });
  try {
    let cursor: string | undefined;
    for (;;) {
      const page = await cold.read({ runId: RUN }, cursor);
      events.push(...page.events);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  } finally {
    await cold.close();
  }
  replayOut = execFileSync(process.execPath, [cliBin, "replay", "--data-dir", dir, "--run", RUN], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 60_000,
  });
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const at = (seq: number): LedgerEvent | undefined => events.find((e) => e.seq === seq);
const ofType = (t: string): LedgerEvent[] => events.filter((e) => e.type === t);
const verdicts = (e: LedgerEvent): HookVerdictPayload => e.payload as HookVerdictPayload;
/** 第 round 轮写入的 HOOK_VERDICT seq 集合（归因锚核对用）。 */
const verdictSeqsInRound = (round: number): number[] =>
  ofType("HOOK_VERDICT")
    .filter((e) => verdicts(e).round === round)
    .map((e) => e.seq);

describe("A6（V6）：任选真实 Run 的账本归因复演（一票否决）", () => {
  it("① 决策序列完整：seq 自 1 连续、归属单一、终态收束", () => {
    expect(events.length).toBeGreaterThan(20);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]?.type).toBe("ASSEMBLY_RECORDED");
    expect(events[events.length - 1]?.type).toBe("RUN_HALTED");
    expect(events.every((e) => e.runId === RUN && e.agentId === AGENT)).toBe(true);
    // 证据行（阶段验收 report.md 抄录；非断言）
    const tally = (t: string): number => ofType(t).length;
    console.info(
      `[A6] events=${events.length} seq=1..${String(events[events.length - 1]?.seq)} ` +
        `rounds=${tally("ROUND_STARTED")} decisions=${tally("DECISION")} ` +
        `hooks=${tally("HOOK_CALLED")}/${tally("HOOK_VERDICT")} authDenied=${tally("AUTH_DENIED")} ` +
        `budget=${tally("BUDGET_RESERVED")}/${tally("BUDGET_SETTLED")} model=${tally(
          "MODEL_INVOKED",
        )}/${tally("MODEL_USAGE")} tool=${tally("TOOL_INVOKE")}/${tally("TOOL_RESULT")} ` +
        `replayLines=${replayOut.trim().split(/\r?\n/).length}`,
    );
  });

  it("② hook 介入成对留痕且改变走向", () => {
    const called = ofType("HOOK_CALLED");
    const marked = ofType("HOOK_VERDICT");
    // toolApproval×2（ok 与 risky；ghost 在 Core 授权即止）+ stopAdvice×5（每轮）+ retryAdvice×1
    expect(called).toHaveLength(8);
    expect(marked).toHaveLength(called.length);
    for (const c of called) {
      const v = at(c.seq + 1);
      expect(v?.type).toBe("HOOK_VERDICT");
      const cp = c.payload as { hook: string; round: number };
      expect(verdicts(v as LedgerEvent).hook).toBe(cp.hook);
      expect(verdicts(v as LedgerEvent).round).toBe(cp.round);
      expect(verdicts(v as LedgerEvent).fallback).toBe(false); // 裁决有效，非超时回落
    }
    // hook① 否决 → 未进 Cell 执行，统一落点 TOOL_RESULT{AUTH/DENIED, by:policy-hook}
    const blocked = ofType("TOOL_RESULT").filter(
      (e) => (e.payload as ToolResultPayload).tool === "risky",
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({
      status: "error",
      error: { code: "AUTH/DENIED", by: "policy-hook", reason: "policy: risky is blocked" },
    });
    expect(
      ofType("TOOL_INVOKE").some((e) => (e.payload as { tool: string }).tool === "risky"),
    ).toBe(false);
    // hook③ 重试 → 同 reqId 派生预扣，失败轮全额退还，MODEL_USAGE 只落一次
    expect(ofType("BUDGET_RESERVED").map((e) => (e.payload as { reqId: string }).reqId)).toEqual([
      "m1",
      "m1#2",
    ]);
    expect(ofType("BUDGET_SETTLED").map((e) => (e.payload as { actual: number }).actual)).toEqual([
      0, 60,
    ]);
    expect(ofType("MODEL_INVOKED")).toHaveLength(2);
    expect(ofType("MODEL_USAGE")).toHaveLength(1);
  });

  it("③ Core 授权拒绝留痕：归因字段齐备且落点可追", () => {
    const denied = ofType("AUTH_DENIED");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toMatchObject({
      subject: AGENT,
      action: "tool.invoke",
      resource: "ghost",
      policyVersion: "p-a6",
    });
    expect(JSON.stringify(denied[0]?.payload)).toContain("no allow rule matches");
    const result = at((denied[0] as LedgerEvent).seq + 1) as LedgerEvent;
    expect(result.type).toBe("TOOL_RESULT");
    expect(result.payload).toMatchObject({
      status: "error",
      error: { code: "AUTH/DENIED", by: "core" },
    });
    expect(
      ofType("TOOL_INVOKE").some((e) => (e.payload as { tool: string }).tool === "ghost"),
    ).toBe(false);
  });

  it("④ 归因锚闭合：basedOn 只引用已发生事件，且覆盖上一轮全部 hook 裁决", () => {
    const decisions = ofType("DECISION");
    expect(decisions).toHaveLength(5);
    for (const d of decisions) {
      const p = d.payload as DecisionPayload;
      expect(p.basedOn.every((s) => s < d.seq && at(s) !== undefined)).toBe(true);
    }
    for (let r = 2; r <= 5; r++) {
      const prior = verdictSeqsInRound(r - 1);
      expect(prior.length).toBeGreaterThan(0);
      const basedOn = (decisions[r - 1] as LedgerEvent).payload as DecisionPayload;
      expect(basedOn.basedOn).toEqual(expect.arrayContaining(prior));
    }
  });

  it("⑤ 交付入口 keel replay 对同一 Run 输出完整归因行", () => {
    expect(replayOut).toContain(`# replay ${RUN} — ${events.length} events`);
    const lines = replayOut.trim().split(/\r?\n/);
    expect(lines).toHaveLength(events.length + 1); // 摘要行 + 每事件一行
    for (const needle of [
      "ASSEMBLY_RECORDED",
      "basedOn=",
      "hook=toolApproval",
      'verdict={"verdict":"deny","reason":"policy: risky is blocked"}',
      'verdict={"policy":"retry","backoffMs":0}',
      "subject=agent-a6 tool.invoke ghost",
      "req=m1 estimate=100 runLeft=900",
      "res=res-1-m1 actual=0 refund=100",
      "MODEL_USAGE",
      "TOOL_RESULT",
      "RUN_HALTED",
    ]) {
      expect(lines.join("\n")).toContain(needle);
    }
  });
});
