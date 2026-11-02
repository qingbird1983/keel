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
  type AuthRule,
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
  RecoveryManager,
  ProcessIsolationProvider,
  SnapshotStore,
  SupervisedCell,
  manifestAuthRules,
  wireCell,
  type CompensationActionCell,
  type LoadedManifest,
} from "@keel/host";

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（src/ 与 dist/ 均在 apps/keel 下一级，上溯三级到根）。 */
export const repoRoot = path.resolve(here, "..", "..", "..");

export const cellEntryPath = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
/** 承接层入口（旧插件专用；CLI 的 observe 与 --legacy 路径都用它，ADR-0010 决策 8）。 */
export const cordisCellEntryPath = path.join(
  repoRoot,
  "packages",
  "cordis-adapter",
  "dist",
  "cell-entry.js",
);
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

/**
 * 演示策略（03 稿 §4 第 2 条留下的"显式选项"）：Phase 1 场景复演与 benchmark 用的全放行表。
 * **装配真实/合成报关单的路径不用它**——那条路必须把 `manifestAuthRules` 的编译结果传进来，
 * 否则"报关单"和"实际权限"是两张皮（开工事实 F2）。
 */
const demoPolicy = {
  version: "p1",
  allow: [
    { subject: "*", action: "tool.invoke", resource: "*" },
    { subject: "*", action: "model.invoke", resource: "*" },
  ],
};

/** 运行期授权策略（版本 + 规则集）；由 `runPolicy` 从报关单编译，或演示路径显式给出。 */
export interface PolicyInput {
  version: string;
  rules: AuthRule[];
}

/**
 * 报关单 → 运行期策略（03 稿 §4 第 2 条：声明编译是唯一规则源）。
 *
 * `tool.invoke` / `model.invoke` 是 **Core→Cell / Core→网关** 方向的执行放行，不由报关单产出
 * （manifest 稿 §5.2：报关单声明的是 Cell 的可见面，不是宿主自己的执行权），所以这里显式补上；
 * Cell 侧的 `tool.register`/`tool.remove`/`net.fetch`/… 一律只来自 `manifest.permissions`——
 * **未声明 = 无规则 = 当场拒并落 `AUTH_DENIED`**（I4，观察期的支点）。
 */
export function runPolicy(
  manifest: LoadedManifest,
  subject: string,
  version = "p-manifest",
): PolicyInput {
  return {
    version,
    rules: [
      ...manifestAuthRules(manifest, subject),
      { subject: "*", action: "tool.invoke", resource: "*" },
      { subject: "*", action: "model.invoke", resource: "*" },
    ],
  };
}

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
  /**
   * 运行期授权策略（03 稿 §4 第 2 条）：装配真实/合成报关单的路径必须显式给出 `runPolicy` 的编译结果。
   * 缺省 = 演示策略 `p1`（只服务 Phase 1 场景复演与 benchmark），不再是无人认领的隐式默认。
   */
  policy?: PolicyInput;
}

/** 一次性装配：Ledger→Authorizer→Budgeter→Context→HookBus→Gateway→Scheduler→快照→补偿→恢复→Supervisor。 */
export async function buildRuntime(
  dataDir: string,
  opts: BuildRuntimeOptions = {},
): Promise<Runtime> {
  assertDist();
  const ledger = new Ledger({ rootDir: dataDir });
  const auth = new Authorizer(
    opts.policy ? { version: opts.policy.version, allow: opts.policy.rules } : demoPolicy,
    ledger,
  );
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
  /** 承接层入口（缺省 = supervisor 的新生态入口；ADR-0010 决策 8，03 稿 §5）。 */
  cellEntry?: string;
  /** 就绪探测超时（缺省 5s = 契约 §7 冷启动口径，ADR-0011）。 */
  readyTimeoutMs?: number;
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
  // 起舱 + 绑通道 + 建分区 + 就绪探测一次做完（host/wire-cell，03 稿 §5）：
  // 装配/热升级/起 run 三条路共用同一个"舱真的能用"凭据（ADR-0011）。
  const { cell } = await wireCell({
    supervisor: rt.supervisor,
    deps: { ledger: rt.ledger, auth: rt.auth, budget: rt.budget, ctx: rt.ctx, gateway: rt.gateway },
    scope,
    ref,
    subject: scope.agentId,
    manifest: opts.manifest,
    pluginPath: opts.pluginPath,
    cellEntry: opts.cellEntry,
    readyTimeoutMs: opts.readyTimeoutMs,
  });
  if (opts.mountState !== undefined) await cell.migrate(opts.mountState);
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
