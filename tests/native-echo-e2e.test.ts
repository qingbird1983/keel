/**
 * 集成测试（真实进程）—— Phase 3 切片②插件 A `echo` 端到端（03 稿 §6，锚 C1【一票否决】/C5/C6）。
 *
 * E1 装配与发现：真报关单（仓库内 keel-plugin.json）过五步校验零豁免 → wireCell 就绪凭据 →
 *    工具只出现在声明的 scope（A 有 echo，无 tool.provide 的对照舱恒空）、TOOL_SCHEMA_CHANGED
 *    恰 1 条且归属本 scope、ASSEMBLY_RECORDED 为 run 首事件、全部事件归属纯净；
 * E2 主场景 run：driver 调 echo，TOOL_INVOKE/TOOL_RESULT 落账本、resultDigest 回读一致、收束 halted；
 * E3 越权调用：无 tool.invoke 规则的主体被调度器当场拒——AUTH_DENIED 落账本 + TOOL_RESULT{error} 统一落点；
 * E4 装载期拒绝：manifest allow 收窄 vs 代码清单不一致 → 静态发布被 AUTH 拒 → 舱 crash →
 *    wireCell 可见失败；账本 AUTH_DENIED(tool.register) 留痕、无任何 TOOL_*（无部分生效）；
 * E5 崩溃半径：kill 一个舱 → 仅该 run 落 RUN_FAILED（在途被打断只能由 kill 造，P-010），
 *    邻居会话照常收束 halted、账本归属纯净；
 * E6 决策重放：echo run 的决策序列从账本重放——seq 连续、ASSEMBLY_RECORDED 首位、
 *    DECISION.basedOn 全部 ≤ throughSeq 且覆盖上一轮全部 TOOL_RESULT、动作序列可重放。
 *
 * 红测先行（03 稿 §4.4，standards/05）：本文件先于 main.ts 的静态发布补丁存在——
 * 补丁前 E1 的发现面断言（可见表 / TOOL_SCHEMA_CHANGED）与 E4 必红，补丁后全绿。
 */

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
  type AssemblyRecordedPayload,
  type AuthDeniedPayload,
  type DecisionPayload,
  type LedgerEvent,
  type RunDriver,
  type RunRef,
  type RunStatus,
  type Scope,
  type ToolInvokePayload,
  type ToolResultPayload,
  type ToolSchemaChangedPayload,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  ProcessIsolationProvider,
  manifestAuthRules,
  wireCell,
  type LoadedManifest,
} from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const pluginPath = path.join(repoRoot, "packages", "plugins", "echo", "dist", "index.js");
const emptyPlugin = path.join(repoRoot, "tests", "fixtures", "empty-plugin.mjs");
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

/** 插件 A 的报关单 = 仓库内真件（不是测试内联副本——校验对象就是发布物本身）。 */
const echoRaw: object = JSON.parse(
  readFileSync(path.join(repoRoot, "packages", "plugins", "echo", "keel-plugin.json"), "utf-8"),
);
/** E4 负例：allow 收窄为 other-*，而插件代码清单是 echo——报关单与代码不一致，装载期必须可见失败。 */
const narrowRaw: object = {
  ...(echoRaw as { meta: object }),
  permissions: [
    { cap: "tool.provide", allow: ["other-*"], reason: "E4 负例：收窄与代码清单不一致" },
  ],
};
/** 对照舱：capability 但零能力声明（permissions 空数组合法）——表恒空，证明 A 的 echo 不越界可见。 */
const emptyRaw: object = {
  kind: "capability",
  meta: {
    name: "empty-probe",
    version: "1.0.0",
    title: "Empty",
    description: "对照舱：无能力声明（03 稿 E1）",
  },
  permissions: [],
  resources: { toolCallTimeoutMs: 10000 },
  compensation: { templates: [] },
  compat: { keelContract: "^1.0" },
};

const echoManifest: LoadedManifest = new Assembler({ schema: manifestSchema }).assemble(echoRaw);
const narrowManifest: LoadedManifest = new Assembler({ schema: manifestSchema }).assemble(
  narrowRaw,
);
const emptyManifest: LoadedManifest = new Assembler({ schema: manifestSchema }).assemble(emptyRaw);

/**
 * 授权策略：register/remove 一律由 manifestAuthRules 按舱编译（不手写通配——E4 的收窄
 * 语义依赖"唯一规则来源是报关单"）；tool.invoke 只授 agent-a（E3 的 stranger 只有 register 规则）。
 */
const policy = {
  version: "p1",
  allow: [
    ...manifestAuthRules(echoManifest, "agent-a"),
    ...manifestAuthRules(echoManifest, "agent-stranger"),
    ...manifestAuthRules(narrowManifest, "agent-narrow"),
    { subject: "agent-a", action: "tool.invoke", resource: "*" },
  ],
};

let dir: string;
let ledger: Ledger;
let auth: Authorizer;
let budget: Budgeter;
let gateway: ModelGateway;
let ctxMgr: ContextManager;
let scheduler: Scheduler;
let supervisor: CellSupervisor;
const cells: { drainAndReap(): Promise<unknown> }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-echo-e2e-"));
  ledger = new Ledger({ rootDir: dir });
  auth = new Authorizer(policy, ledger);
  budget = new Budgeter(ledger);
  ctxMgr = new ContextManager();
  gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
  });
  scheduler = new Scheduler({
    ledger,
    auth,
    budget,
    ctx: ctxMgr,
    hooks: new HookBus(ledger),
    gateway,
  });
  supervisor = new CellSupervisor({
    provider: new ProcessIsolationProvider(),
    cellEntryPath: cellEntry,
    toolKillGraceMs: 5_000,
    onCellExit: (e) => {
      const ref = e.cell.ref;
      if (ref) void scheduler.abort(ref.runId, e.reasonCode, e.message);
    },
  });
});

afterAll(async () => {
  await Promise.allSettled(cells.map((c) => c.drainAndReap()));
  await ledger.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** 起 echo/对照舱并直接返回（wireCell 返回 = 就绪凭据已到手）。 */
async function wire(
  scope: Scope,
  runId: string,
  manifest: LoadedManifest,
  plugin: string,
  subject = scope.agentId,
) {
  const ref: RunRef = { ...scope, runId };
  const { cell } = await wireCell({
    supervisor,
    deps: { ledger, auth, budget, ctx: ctxMgr, gateway },
    scope,
    ref,
    subject,
    manifest,
    pluginPath: plugin,
  });
  cells.push(cell);
  return { ref, cell };
}

async function readRun(runId: string): Promise<LedgerEvent[]> {
  return (await ledger.read({ runId })).events;
}

/** 轮询直至条件成立（真实子进程时序屏障，P-006：轮号不是稳定量，用显式同步不用 sleep）。 */
async function until(pred: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const E2_TEXTS = ["keel-echo-e2e", "第二轮·中文"];

describe("Phase 3 切片②：插件 A echo 端到端（真实进程）", () => {
  it("E1+E2：装配零豁免 → 发现面 scope 隔离 → 主场景 run 收束 halted（C1）", async () => {
    const scopeB: Scope = { agentId: "agent-a", sessionId: "sess-b" };
    const a = await wire(
      { agentId: "agent-a", sessionId: "sess-a" },
      "run-a",
      echoManifest,
      pluginPath,
    );
    const b = await wire(scopeB, "run-b", emptyManifest, emptyPlugin);

    // 对照舱内驱动只看表：B 的可见表必须恒空（A 的 echo 零出现 = I5 不越界可见）
    const seenB: string[][] = [];
    const { done: doneB } = scheduler.start({
      ref: b.ref,
      subject: scopeB.agentId,
      executor: b.cell.executor,
      driver: {
        decide: async (c) => {
          seenB.push(c.tools.map((t) => `${t.name}@${t.schemaVersion}`));
          return { done: true, summary: "runB-end" };
        },
      },
      assembly: emptyManifest.record,
    });
    b.cell.attachRun(b.ref);

    // A 驱动：逐轮记录可见表（E1）+ 调 echo（E2）
    const seenA: string[][] = [];
    const { done: doneA } = scheduler.start({
      ref: a.ref,
      subject: a.ref.agentId,
      executor: a.cell.executor,
      driver: {
        decide: async (c) => {
          seenA.push(c.tools.map((t) => `${t.name}@${t.schemaVersion}`));
          if (c.round > E2_TEXTS.length) return { done: true, summary: "runA-end" };
          return {
            summary: `r${c.round}`,
            actions: [{ kind: "tool", tool: "echo", params: { text: E2_TEXTS[c.round - 1] } }],
          };
        },
      },
      assembly: echoManifest.record,
    });
    a.cell.attachRun(a.ref);

    const [sa, sb] = (await Promise.all([doneA, doneB])) as [RunStatus, RunStatus];
    // 终态是第一条断言（P-008）
    expect(sa.state).toBe("halted");
    expect(sb.state).toBe("halted");

    // E1：A 决策输入逐轮恰 [echo@1]（含收束轮，共 E2_TEXTS.length + 1 次 decide）；B 恒空
    expect(seenA).toEqual([["echo@1"], ["echo@1"], ["echo@1"]]);
    expect(seenB).toEqual([[]]); // B 单轮即收束（done），表恒空

    // A 账本：归属纯净 + 首事件 ASSEMBLY_RECORDED + 变更恰 1 条归属本 scope 且先于首轮决策
    const evsA = await readRun(a.ref.runId);
    expect(evsA.every((e) => e.runId === a.ref.runId && e.sessionId === "sess-a")).toBe(true);
    expect(evsA[0]?.type).toBe("ASSEMBLY_RECORDED");
    expect((evsA[0]?.payload as AssemblyRecordedPayload).manifest).toEqual({
      name: "echo",
      version: "1.0.0",
      kind: "capability",
    });
    const changes = evsA.filter((e) => e.type === "TOOL_SCHEMA_CHANGED");
    expect(changes).toHaveLength(1);
    expect((changes[0]?.payload as ToolSchemaChangedPayload).tool).toBe("echo");
    expect((changes[0]?.payload as ToolSchemaChangedPayload).affectedScope).toEqual({
      agentId: "agent-a",
      sessionId: "sess-a",
    });
    expect(evsA.findIndex((e) => e.type === "TOOL_SCHEMA_CHANGED")).toBeLessThan(
      evsA.findIndex((e) => e.type === "DECISION"),
    );

    // E2：逐轮 INVOKE/RESULT 成对、status ok、digest 回读一致（{echoed} 形）
    const invocations = evsA.filter((e) => e.type === "TOOL_INVOKE");
    const results = evsA.filter((e) => e.type === "TOOL_RESULT");
    expect(invocations).toHaveLength(E2_TEXTS.length);
    expect(results).toHaveLength(E2_TEXTS.length);
    results.forEach((e, i) => {
      const p = e.payload as ToolResultPayload;
      expect(p.status).toBe("ok");
      expect(p.resultDigest).toEqual({ echoed: E2_TEXTS[i] });
    });

    // B 账本：归属纯净且无 echo 痕迹（TOOL_SCHEMA_CHANGED 恒零——它没声明 tool.provide）
    const evsB = await readRun(b.ref.runId);
    expect(evsB.every((e) => e.runId === b.ref.runId && e.sessionId === "sess-b")).toBe(true);
    expect(evsB.some((e) => e.type === "TOOL_SCHEMA_CHANGED")).toBe(false);
    expect(JSON.stringify(evsB.map((e) => e.payload))).not.toContain("echo");
  });

  it("E3：无 tool.invoke 规则的主体被当场拒，AUTH_DENIED 落账本（C1/I1）", async () => {
    const s = await wire(
      { agentId: "agent-stranger", sessionId: "sess-stranger" },
      "run-stranger",
      echoManifest,
      pluginPath,
    );
    const { done } = scheduler.start({
      ref: s.ref,
      subject: s.ref.agentId,
      executor: s.cell.executor,
      driver: {
        decide: async (c) => {
          if (c.round > 1) return { done: true, summary: "stranger-end" };
          return {
            summary: "s1",
            actions: [{ kind: "tool", tool: "echo", params: { text: "should-deny" } }],
          };
        },
      },
      assembly: echoManifest.record,
    });
    s.cell.attachRun(s.ref);
    const st = await done;
    expect(st.state).toBe("halted"); // 拒绝是动作级落点，run 继续到正常收束

    const evs = await readRun(s.ref.runId);
    const denied = evs.filter((e) => e.type === "AUTH_DENIED");
    expect(denied).toHaveLength(1);
    const dp = denied[0]?.payload as AuthDeniedPayload;
    expect(dp.subject).toBe("agent-stranger");
    expect(dp.action).toBe("tool.invoke");
    expect(dp.resource).toBe("echo");

    const results = evs.filter((e) => e.type === "TOOL_RESULT");
    expect(results).toHaveLength(1);
    const rp = results[0]?.payload as ToolResultPayload;
    expect(rp.status).toBe("error");
    expect((rp.error as { code?: string })?.code).toBe("AUTH/DENIED");
    // 拒绝路径零执行：无 ok 结果、无补偿/效果事件
    expect(evs.some((e) => e.type === "EFFECT_DECLARED")).toBe(false);
  });

  it("E4：allow 收窄与代码清单不一致 → 发布被拒 → 舱 crash → wireCell 可见失败（C1）", async () => {
    const n = { agentId: "agent-narrow", sessionId: "sess-narrow" } as Scope;
    const ref: RunRef = { ...n, runId: "run-narrow" };
    let caught: unknown;
    try {
      await wireCell({
        supervisor,
        deps: { ledger, auth, budget, ctx: ctxMgr, gateway },
        scope: n,
        ref,
        subject: n.agentId,
        manifest: narrowManifest,
        pluginPath,
      });
    } catch (err) {
      caught = err;
    }
    // 可见失败：错误码沿用封闭集合（通道断 → BADFRAME；等不到 → TIMEOUT），拒绝装配
    const code = (caught as { code?: string } | undefined)?.code;
    expect(["TRANSPORT/BADFRAME", "TRANSPORT/TIMEOUT"]).toContain(code);
    expect((caught as { detail?: { reason?: string } } | undefined)?.detail?.reason).toBe(
      "CELL_NOT_READY",
    );

    // 账本留痕：装载期 AUTH_DENIED(tool.register, echo) + 无任何 TOOL_* 事件（无部分生效）
    const evs = await readRun(ref.runId);
    const denied = evs.filter((e) => e.type === "AUTH_DENIED");
    expect(denied).toHaveLength(1);
    const dp = denied[0]?.payload as AuthDeniedPayload;
    expect(dp.subject).toBe("agent-narrow");
    expect(dp.action).toBe("tool.register");
    expect(dp.resource).toBe("echo");
    expect(evs.some((e) => e.type.startsWith("TOOL_"))).toBe(false);
  });

  it("E6：决策序列可从账本重放——throughSeq 上界 + basedOn 覆盖 + 动作可重放（C6）", async () => {
    const evs = await readRun("run-a");
    // seq 自 1 连续无缺口
    evs.forEach((e, i) => expect(e.seq).toBe(i + 1));

    const decisions = evs.filter((e) => e.type === "DECISION");
    expect(decisions).toHaveLength(E2_TEXTS.length + 1); // 两轮动作 + 收束轮
    for (const d of decisions) {
      const p = d.payload as DecisionPayload;
      expect(p.basedOn.length).toBeGreaterThan(0);
      // 上界语义：basedOn 全部 ≤ throughSeq，throughSeq 在本事件 seq 之前盖章
      expect(Math.max(...p.basedOn)).toBeLessThanOrEqual(p.throughSeq ?? Number.NEGATIVE_INFINITY);
      expect(p.throughSeq).toBeLessThan(d.seq);
      // 覆盖上一轮全部 TOOL_RESULT（决策看见过它们）
      const prev = evs.filter(
        (e) => e.type === "TOOL_RESULT" && (e.payload as ToolResultPayload).round < p.round,
      );
      for (const r of prev) expect(p.basedOn).toContain(r.seq);
    }
    // 动作序列可重放：每轮 DECISION + 同轮 TOOL_INVOKE 的 tool/paramsDigest 重放出 driver 剧本
    E2_TEXTS.forEach((text, i) => {
      const dec = decisions.find((e) => (e.payload as DecisionPayload).round === i + 1);
      expect(dec?.type).toBe("DECISION");
      const inv = evs.find(
        (e) => e.type === "TOOL_INVOKE" && (e.payload as ToolInvokePayload).round === i + 1,
      );
      expect((inv?.payload as ToolInvokePayload).tool).toBe("echo");
      expect((inv?.payload as ToolInvokePayload).paramsDigest).toEqual({ text });
    });
  });

  it("E5：kill 一个舱 → 仅该 run 落 RUN_FAILED，邻居会话照常收束（C5/I2）", async () => {
    const scopeV: Scope = { agentId: "agent-a", sessionId: "sess-e5-a" };
    const scopeN2: Scope = { agentId: "agent-a", sessionId: "sess-e5-b" };
    const v = await wire(scopeV, "run-e5-a", echoManifest, pluginPath);
    const n2 = await wire(scopeN2, "run-e5-b", echoManifest, pluginPath);

    // 受害者：轮 2 前挂起等测试完成 kill（在途被打断只能由 kill 造，P-010）
    let releaseVictim!: () => void;
    const killed = new Promise<void>((res) => {
      releaseVictim = res;
    });
    const victimDriver: RunDriver = {
      decide: async (c) => {
        if (c.round === 1) {
          return {
            summary: "v-r1",
            actions: [{ kind: "tool", tool: "echo", params: { text: "victim" } }],
          };
        }
        await killed;
        return {
          summary: "v-r2",
          actions: [{ kind: "tool", tool: "echo", params: { text: "after-kill" } }],
        };
      },
    };
    const bystanderDriver: RunDriver = {
      decide: async (c) => {
        if (c.round > 2) return { done: true, summary: "n2-end" };
        return {
          summary: `n2-r${c.round}`,
          actions: [{ kind: "tool", tool: "echo", params: { text: `bystander-${c.round}` } }],
        };
      },
    };
    const pv = scheduler.start({
      ref: v.ref,
      subject: scopeV.agentId,
      executor: v.cell.executor,
      driver: victimDriver,
      assembly: echoManifest.record,
    });
    v.cell.attachRun(v.ref);
    const pn = scheduler.start({
      ref: n2.ref,
      subject: scopeN2.agentId,
      executor: n2.cell.executor,
      driver: bystanderDriver,
      assembly: echoManifest.record,
    });
    n2.cell.attachRun(n2.ref);

    // 受害者首轮落账 → kill（此时其轮 2 挂起）→ 放行
    await until(async () => (await readRun(v.ref.runId)).some((e) => e.type === "TOOL_RESULT"));
    await v.cell.kill();
    releaseVictim();

    const [sv, sn] = (await Promise.all([pv.done, pn.done])) as [RunStatus, RunStatus];
    expect(sv.state).toBe("failed");
    expect(sn.state).toBe("halted");

    // 受害者账本有 RUN_FAILED；旁观者账本归属纯净、无受害者痕迹、逐轮 ok
    expect((await readRun(v.ref.runId)).some((e) => e.type === "RUN_FAILED")).toBe(true);
    const evsN = await readRun(n2.ref.runId);
    expect(evsN.every((e) => e.runId === n2.ref.runId && e.sessionId === "sess-e5-b")).toBe(true);
    const resultsN = evsN.filter((e) => e.type === "TOOL_RESULT");
    expect(resultsN).toHaveLength(2);
    expect(resultsN.every((e) => (e.payload as ToolResultPayload).status === "ok")).toBe(true);
    expect(JSON.stringify(evsN.map((e) => e.payload))).not.toContain("victim");
  });
});
