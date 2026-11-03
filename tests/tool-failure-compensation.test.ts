/**
 * 集成测试（真实进程）—— 验收 A4 主张（V4，一票否决）的测试化：
 * 工具调用失败触发回滚：全部已发生效果有对应 COMPENSATION_EXECUTED（或有意识豁免记录），
 * 补偿三路径实测：
 *   ① 幂等重入（keyed 重派无重复副作用 + 投影闭环后重扫不重派）
 *   ② 自身失败升级（T11/T12：≤3 次退避重试 → COMPENSATION_ESCALATED → RECOVER/COMPENSATION-FAILED）
 *   ③ record-only 降级（审计留痕 + 告警缝，A6-3）
 *
 * 补偿动作经一次性新补偿 Cell 进程执行（ADR-0005「新 Cell」路径）：factory spawn 同插件
 * 子进程 → compensation.exec → dispose。阶段验收时由 apps/keel CLI 复演。
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
  type LedgerEvent,
  type RunDriver,
  type RunRef,
  type RunStatus,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  CompensationExecutor,
  EffectTracker,
  ProcessIsolationProvider,
  serveCellChannel,
  type CompensationActionCell,
  type LoadedManifest,
} from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const plugin = path.join(repoRoot, "tests", "fixtures", "compensate-plugin.mjs");
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

// 装载期静态发布经 tool.register 裁决（03 稿 §4）：规则必须来自报关单编译面（此处与无 allow 报关单等价）
const policy = {
  version: "p1",
  allow: [
    { subject: "*", action: "tool.invoke", resource: "*" },
    { subject: "*", action: "tool.register", resource: "*" },
    { subject: "*", action: "tool.remove", resource: "*" },
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
let compensationExecutor: CompensationExecutor;
let compActionSeq = 0;
const ledgers: Ledger[] = [];
const alerts: { runId: string; effectId: string; escalated: boolean }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-a4-"));
  ledger = new Ledger({ rootDir: dir });
  ledgers.push(ledger);
  auth = new Authorizer(policy, ledger);
  budget = new Budgeter(ledger);
  ctxMgr = new ContextManager();
  scheduler = new Scheduler({
    ledger,
    auth,
    budget,
    ctx: ctxMgr,
    hooks: new HookBus(ledger),
    gateway: (gateway = new ModelGateway({
      ledger,
      auth,
      budget,
      upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
    })),
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
  // 补偿执行器必须在 beforeAll 构造（捕获已就绪的 ledger；模块顶层构造会捕获 undefined）
  compensationExecutor = new CompensationExecutor(
    {
      ledger,
      factory: async (): Promise<CompensationActionCell> => {
        const cell = supervisor.spawnCell({ manifest, pluginPath: plugin });
        // 动作舱同样是默认入口舱：装载义务含静态发布（03 稿 §4），spawn 即接 serve + alloc，
        // 否则装载期 tool.register 落 BADFRAME、舱装载即死、补偿必失败。
        compActionSeq += 1;
        const scope = { agentId: "agent-a4", sessionId: `comp-action-${String(compActionSeq)}` };
        serveCellChannel(
          cell.conn,
          {
            scope,
            ref: { ...scope, runId: `comp-action-${String(compActionSeq)}` },
            subject: scope.agentId,
            templates: new Map(manifest.templates.map((t) => [t.kind, t])),
          },
          { ledger, auth, budget, ctx: ctxMgr, gateway, tracker: new EffectTracker({ ledger }) },
        );
        ctxMgr.alloc(scope);
        const timeout = (manifest.resources.toolCallTimeoutMs ?? 0) + supervisor.graceMs + 1_000;
        return {
          exec: (input) => cell.conn.request("compensation.exec", input, timeout),
          dispose: () => cell.drainAndReap(),
        };
      },
    },
    { onAlert: async (info) => void alerts.push(info) },
  );
});

afterAll(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** 三类补偿模板（kind → class/action），manifest 与声明一一对应（C-M1）。 */
const manifest: LoadedManifest = new Assembler({ schema: manifestSchema }).assemble({
  kind: "capability",
  meta: { name: "plug", version: "1.0.0", title: "P", description: "a4 fixture" },
  permissions: [{ cap: "tool.provide" }],
  resources: { toolCallTimeoutMs: 10_000 },
  compensation: {
    templates: [
      {
        kind: "test.undo",
        class: "reversible",
        action: { type: "plugin", ref: "undo" },
        idempotency: "keyed",
      },
      {
        kind: "test.fail",
        class: "reversible",
        action: { type: "plugin", ref: "always-fail" },
        idempotency: "natural",
      },
      {
        kind: "test.record",
        class: "record-only",
        action: { type: "plugin", ref: "mark" },
        idempotency: "natural",
      },
    ],
  },
  compat: { keelContract: "^1.0" },
});

/** 补偿动作通道 = 一次性新补偿 Cell（ADR-0005「新 Cell」；宿主胶水位，生产归 apps/keel）。 */

/**
 * 装配一个 run：工具首轮声明效果后自身失败；第二轮等 gate（保证测试可在轮间 cancel）。
 * compensator 接补偿执行器（run 模式 = T5 cancel 全 Run 回滚）。
 */
function wireScope(params: { runId: string; effectKind: string; gate?: Promise<void> }): {
  ref: RunRef;
  done: Promise<RunStatus>;
} {
  const scope = { agentId: "agent-a4", sessionId: `sess-${params.runId}` };
  const ref: RunRef = { ...scope, runId: params.runId };
  const tracker = new EffectTracker({ ledger });
  const cell = supervisor.spawnCell({ manifest, pluginPath: plugin, tracker });
  serveCellChannel(
    cell.conn,
    {
      scope,
      ref,
      subject: scope.agentId,
      templates: new Map(manifest.templates.map((t) => [t.kind, t])),
    },
    // deps 全量（装载期静态发布 tool.register 走 auth/ctx——03 稿 §4）；此前残缺被旧行为掩盖
    { ledger, auth, budget, ctx: ctxMgr, gateway, tracker },
  );
  ctxMgr.alloc(scope);
  const driver: RunDriver = {
    decide: async (c) => {
      if (c.round === 1) {
        return {
          summary: "arm",
          actions: [
            { kind: "tool", tool: "fail-with-effect", params: { effectKind: params.effectKind } },
          ],
        };
      }
      if (params.gate) await params.gate;
      return { done: true, summary: "released" };
    },
  };
  const { done } = scheduler.start({
    ref,
    subject: scope.agentId,
    executor: cell.executor,
    driver,
    assembly: manifest.record,
    compensator: (mode) => compensationExecutor.compensate(ref, { mode }),
  });
  cell.attachRun(ref);
  return { ref, done };
}

async function readRun(runId: string): Promise<LedgerEvent[]> {
  return (await ledger.read({ runId })).events;
}

async function until(pred: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("A4（V4）：工具调用失败触发回滚（真实进程）", () => {
  it("① 幂等重入：失败效果 verify-pending → cancel 回滚 → 新补偿 Cell 撤销；重扫不重派", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ref, done } = wireScope({ runId: "a4-undo", effectKind: "test.undo", gate });
    // 等效果落定（工具失败 → 结果未知 → verify-pending 保守路径）
    await until(async () =>
      (await readRun(ref.runId)).some(
        (e) =>
          e.type === "EFFECT_SETTLED" && (e.payload as { outcome?: string }).outcome === "unknown",
      ),
    );
    void scheduler.cancel(ref.runId); // T5：全 Run compensable
    release();
    const status = await done;
    expect(status.state).toBe("halted"); // cancel 语义：补偿成功 → RUN_HALTED

    const evs = await readRun(ref.runId);
    const settled = evs.find((e) => e.type === "EFFECT_SETTLED");
    expect(settled?.payload).toMatchObject({ outcome: "unknown" });
    const executed = evs.find((e) => e.type === "COMPENSATION_EXECUTED");
    expect(executed?.payload).toMatchObject({
      effectId: (settled?.payload as { effectId: string }).effectId,
      attempt: 1,
      resultDigest: { undone: true }, // keyed 幂等：宿主传 effectId，目标按其去重
    });
    // 幂等重入（A6-2 投影层）：闭环后重扫不重派、无重复 EXECUTED
    expect(await compensationExecutor.compensate(ref, { mode: "run" })).toBe(true);
    expect(
      (await readRun(ref.runId)).filter((e) => e.type === "COMPENSATION_EXECUTED"),
    ).toHaveLength(1);
  }, 30_000);

  it("② 自身失败升级：3 次退避重试 → ESCALATED → RUN_FAILED{RECOVER/COMPENSATION-FAILED}", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ref, done } = wireScope({ runId: "a4-escalate", effectKind: "test.fail", gate });
    await until(async () => (await readRun(ref.runId)).some((e) => e.type === "EFFECT_DECLARED"));
    void scheduler.cancel(ref.runId);
    release();
    const status = await done;
    // 升级阻断（T12）：补偿 false → cancel 收束转 failRun
    expect(status).toMatchObject({ state: "failed", reasonCode: "RECOVER/COMPENSATION-FAILED" });
    const evs = await readRun(ref.runId);
    const esc = evs.find((e) => e.type === "COMPENSATION_ESCALATED");
    expect(esc?.payload).toMatchObject({ attempts: 3, blockedResume: true });
    expect(alerts.some((a) => a.ref.runId === ref.runId && a.escalated)).toBe(true);
  }, 40_000);

  it("③ record-only 降级：审计留痕 + 告警闭环（A6-3），不因不可逆而失败", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ref, done } = wireScope({ runId: "a4-record", effectKind: "test.record", gate });
    await until(async () => (await readRun(ref.runId)).some((e) => e.type === "EFFECT_DECLARED"));
    void scheduler.cancel(ref.runId);
    release();
    const status = await done;
    expect(status.state).toBe("halted");
    const evs = await readRun(ref.runId);
    const rec = evs.find((e) => e.type === "COMPENSATION_EXECUTED");
    expect(rec?.payload).toMatchObject({ resultDigest: { recordOnly: true } });
    expect(alerts.some((a) => a.ref.runId === ref.runId && !a.escalated)).toBe(true);
  }, 30_000);
});
