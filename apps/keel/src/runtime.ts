/**
 * CLI 装配运行时 —— 薄壳共享原语（04 稿 §2）：buildRuntime 一次性装配全部内核组件，
 * wireRun 单 run 接线。接线序与 tests/ 三份集成 rig 同构；业务语义全部下沉 packages/。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  type Scope,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  CompensationExecutor,
  EffectTracker,
  ProcessIsolationProvider,
  RecoveryManager,
  SnapshotStore,
  SupervisedCell,
  serveCellChannel,
  type CompensationActionCell,
  type LoadedManifest,
} from "@keel/host";

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（src/ 与 dist/ 均在 apps/keel 下一级，上溯三级到根）。 */
export const repoRoot = path.resolve(here, "..", "..", "..");

const cellEntryPath = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const schemaPath = path.join(
  repoRoot,
  "docs",
  "design",
  "phase-1",
  "schema",
  "keel-plugin.schema.json",
);

/** 子进程只能跑 dist：入口缺失即明确报错（04 稿 §2 前置检查）。 */
export function assertDist(): void {
  if (!existsSync(cellEntryPath)) {
    throw new Error(`cell-runtime entry missing: ${cellEntryPath} — run "pnpm build" first`);
  }
}

export function loadSchema(): unknown {
  return JSON.parse(readFileSync(schemaPath, "utf-8"));
}

export function assembleManifest(raw: unknown): LoadedManifest {
  return new Assembler({ schema: loadSchema() }).assemble(raw);
}

/** tests/fixtures/ 下的桩路径（CLI 复演的注入材料）。 */
export function fixturePath(name: string): string {
  return path.join(repoRoot, "tests", "fixtures", name);
}

/** CLI 演示策略：tool/model 两面全放行（授权语义由场景自证，非 CLI 职责）。 */
const policy = {
  version: "p1",
  allow: [
    { subject: "*", action: "tool.invoke", resource: "*" },
    { subject: "*", action: "model.invoke", resource: "*" },
  ],
};

export interface AlertRecord {
  runId: string;
  effectId: string;
  escalated: boolean;
}

export interface Runtime {
  ledger: Ledger;
  auth: Authorizer;
  budget: Budgeter;
  ctx: ContextManager;
  gateway: ModelGateway;
  scheduler: Scheduler;
  snapshots: SnapshotStore;
  supervisor: CellSupervisor;
  compensator: CompensationExecutor;
  recovery: RecoveryManager;
  /** record-only / 升级告警缝的收集器（scenario 断言用）。 */
  alerts: AlertRecord[];
  /** runId → 在途 Cell（onCheckpoint 快照索取缝的查找表，切片④）。 */
  bindings: Map<string, { scope: Scope; cell: SupervisedCell }>;
  close(): Promise<void>;
}

export interface BuildRuntimeOptions {
  /** 补偿动作 Cell 的材料（ADR-0005「新 Cell」一次性通道）；缺省 = record-only 直闭，无通道。 */
  actionSpec?: { manifest: LoadedManifest; pluginPath: string };
}

/** 一次性装配：Ledger→Authorizer→Budgeter→Context→HookBus→Gateway→Scheduler→快照→补偿→恢复→Supervisor。 */
export async function buildRuntime(
  dataDir: string,
  opts: BuildRuntimeOptions = {},
): Promise<Runtime> {
  assertDist();
  const ledger = new Ledger({ rootDir: dataDir });
  const auth = new Authorizer(policy, ledger);
  const budget = new Budgeter(ledger);
  const ctx = new ContextManager();
  const snapshots = new SnapshotStore();
  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
  });
  const rt: Runtime = {
    ledger,
    auth,
    budget,
    ctx,
    gateway,
    scheduler: null as unknown as Scheduler,
    snapshots,
    supervisor: null as unknown as CellSupervisor,
    compensator: null as unknown as CompensationExecutor,
    recovery: null as unknown as RecoveryManager,
    alerts: [],
    bindings: new Map(),
    close: async () => undefined,
  };
  rt.scheduler = new Scheduler(
    { ledger, auth, budget, ctx, hooks: new HookBus(ledger), gateway },
    {
      // 快照索取缝（D3，切片④）：CHECKPOINT → STATE_SNAPSHOT_REF → ROUND_ENDED（I3 顺序）
      onCheckpoint: async (r, info) => {
        const b = rt.bindings.get(r.runId);
        if (!b) return;
        const state = await b.cell.pullSnapshot();
        const meta = snapshots.save(
          { agentId: r.agentId, sessionId: r.sessionId },
          info.round,
          state,
        );
        if (meta) {
          await ledger.append(r, "STATE_SNAPSHOT_REF", {
            ref: meta.ref,
            version: meta.version,
            round: info.round,
          });
        }
      },
    },
  );
  rt.supervisor = new CellSupervisor({
    provider: new ProcessIsolationProvider(),
    cellEntryPath,
    toolKillGraceMs: 5_000,
    onCellExit: (e) => {
      const ref = e.cell.ref;
      if (ref) void rt.scheduler.abort(ref.runId, e.reasonCode, e.message);
    },
  });
  rt.compensator = new CompensationExecutor(
    opts.actionSpec
      ? {
          ledger,
          // 补偿动作通道 = 一次性新补偿 Cell：同插件 spawn → compensation.exec → dispose（A4 rig 同构）
          factory: async (): Promise<CompensationActionCell> => {
            const spec = opts.actionSpec as { manifest: LoadedManifest; pluginPath: string };
            const cell = rt.supervisor.spawnCell({
              manifest: spec.manifest,
              pluginPath: spec.pluginPath,
            });
            const timeout =
              (spec.manifest.resources.toolCallTimeoutMs ?? 0) + rt.supervisor.graceMs + 1_000;
            return {
              exec: (input) => cell.conn.request("compensation.exec", input, timeout),
              dispose: () => cell.drainAndReap(),
            };
          },
        }
      : { ledger, factory: null },
    {
      onAlert: async (info) =>
        void rt.alerts.push({
          runId: info.ref.runId,
          effectId: info.effectId,
          escalated: info.escalated,
        }),
    },
  );
  rt.recovery = new RecoveryManager({ ledger, compensator: rt.compensator, snapshots });
  return rt;
}

export interface WireRunOptions {
  runId: string;
  scope?: Scope;
  driver: RunDriver;
  manifest: LoadedManifest;
  pluginPath: string;
  /** 接补偿执行器（run 模式 = 全 Run 回滚）；缺省不接（效果留待恢复投影，A3 场景用）。 */
  withCompensator?: boolean;
  recoveredFrom?: { runId: string; seq: number };
  /** 恢复挂载态：非 undefined 时经 cell.migrate 挂载（契约 §4.5 切片④注记，serve 前执行）。 */
  mountState?: unknown;
}

export interface WiredRun {
  ref: RunRef;
  cell: SupervisedCell;
  done: Promise<RunStatus>;
}

/** 单 run 接线：spawn →（挂载）→ serve（全套 deps）→ ctx.alloc → start → attachRun（P-002：参数位与 hook 时序）。 */
export async function wireRun(rt: Runtime, opts: WireRunOptions): Promise<WiredRun> {
  const scope = opts.scope ?? { agentId: "keel-cli", sessionId: `sess-${opts.runId}` };
  const ref: RunRef = { ...scope, runId: opts.runId };
  const tracker = new EffectTracker({ ledger: rt.ledger });
  const cell = rt.supervisor.spawnCell({
    manifest: opts.manifest,
    pluginPath: opts.pluginPath,
    tracker,
  });
  if (opts.mountState !== undefined) await cell.migrate(opts.mountState);
  serveCellChannel(
    cell.conn,
    {
      scope,
      ref,
      subject: scope.agentId,
      templates: new Map(opts.manifest.templates.map((t) => [t.kind, t])),
    },
    {
      ledger: rt.ledger,
      auth: rt.auth,
      budget: rt.budget,
      ctx: rt.ctx,
      gateway: rt.gateway,
      tracker,
    },
  );
  rt.ctx.alloc(scope);
  const { done } = rt.scheduler.start({
    ref,
    subject: scope.agentId,
    executor: cell.executor,
    driver: opts.driver,
    assembly: opts.manifest.record,
    compensator: opts.withCompensator
      ? (mode) => rt.compensator.compensate(ref, { mode })
      : undefined,
    recoveredFrom: opts.recoveredFrom,
  });
  cell.attachRun(ref);
  rt.bindings.set(ref.runId, { scope, cell });
  return { ref, cell, done };
}

/** 关闭：收束全部在途 Cell + 落盘账本（standards/04 确定性释放）。 */
export async function closeRuntime(rt: Runtime): Promise<void> {
  await Promise.allSettled([...rt.bindings.values()].map((b) => b.cell.drainAndReap()));
  rt.bindings.clear();
  await rt.ledger.close();
}

/** 事件读取捷径（场景断言 / 命令摘要共用）。 */
export async function readRun(rt: Runtime, runId: string): Promise<LedgerEvent[]> {
  return (await rt.ledger.read({ runId })).events;
}

/** 条件等待（轮询账本；超时抛错）。 */
export async function until(pred: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}
