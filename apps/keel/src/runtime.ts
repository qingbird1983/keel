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
  ToolCatalog,
  HookBus,
  Ledger,
  ModelGateway,
  Scheduler,
  type AuthRule,
  type LedgerEvent,
  type ModelUpstream,
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
  wirePolicies,
  type CompensationActionCell,
  type LoadedManifest,
  type PolicyBinding,
  type PolicySpec,
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
/** Profile 结构 Schema（Phase 4 切片②；`keel validate --profile` 与 `keel run --profile` 共用）。 */
const profileSchemaPath = path.join(
  repoRoot,
  "docs",
  "design",
  "phase-4",
  "schema",
  "keel-profile.schema.json",
);
/**
 * 策略插件的进程入口（切片④，ADR-0012）：与能力舱同 supervisor、同帧协议，
 * 但受理面只有 `policy.hook`，且不注入任何主动接口。
 */
export const policyCellEntryPath = path.join(
  repoRoot,
  "packages",
  "cell-runtime",
  "dist",
  "policy-main.js",
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

export function loadProfileSchema(): unknown {
  return JSON.parse(readFileSync(profileSchemaPath, "utf-8"));
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
    { subject: "*", action: "model.stream", resource: "*" },
  ],
};

/**
 * 演示上游（MVP 无凭证桩，ADR-0003）：非流式回空结果；流式按请求参数 `chunks` 给分片
 * （B7④ 的真进程样本与 `keel bench` 的流式一行都用它，不需要再造第二个测试运行时）。
 * 每片 `cost:1` = 权威计量的演示口径；`usage` 随片累计（末片即终值）。
 * 断流的两条路径（等待超时、上游中途抛）由 `ModelGateway` 的时限注入位在单测里造，
 * 这里不放"假装挂住"的旋钮——CLI 侧没有对应的参数，留着就是没人能按下的开关。
 */
const stubUpstream: ModelUpstream = {
  invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }),
  async *stream(req: { model: string; params: unknown }) {
    const p = (req.params ?? {}) as { chunks?: number };
    const n = Math.max(1, Math.min(64, Math.trunc(p.chunks ?? 4) || 1));
    for (let i = 1; i <= n; i++) {
      yield { chunk: { seq: i, text: `chunk-${i}` }, cost: 1, usage: { parts: i, tokens: i * 4 } };
    }
  },
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
  return runPolicyFor([{ manifest, subject }], version);
}

/** 多舱合并版 runPolicy（03 稿 §4 集成面：默认入口发布静态工具经 tool.register 裁决，规则必须来自报关单）。 */
export function runPolicyFor(
  entries: { manifest: LoadedManifest; subject: string }[],
  version = "p-manifest",
): PolicyInput {
  return {
    version,
    rules: [
      ...entries.flatMap((e) => manifestAuthRules(e.manifest, e.subject)),
      { subject: "*", action: "tool.invoke", resource: "*" },
      { subject: "*", action: "model.invoke", resource: "*" },
      // 流式与调用模型是同一项权威的两个入口（ADR-0013 决策 6）：宿主放行面同步给到 model.stream，
      // 舱能不能真的流式仍由"报关单 model.adapter + 网关授权"裁决，缺一即拒。
      { subject: "*", action: "model.stream", resource: "*" },
    ],
  };
}

export interface AlertRecord {
  runId: string;
  effectId: string;
  escalated: boolean;
}

/** 快照落盘失败记录（切片⑤ §3.2 第 4 步的"可见失败"落点：不静默跳过，也不新增错误码）。 */
export interface SnapshotFailureRecord {
  runId: string;
  round: number;
  message: string;
}

export interface Runtime {
  ledger: Ledger;
  auth: Authorizer;
  budget: Budgeter;
  ctx: ToolCatalog;
  gateway: ModelGateway;
  scheduler: Scheduler;
  snapshots: SnapshotStore;
  supervisor: CellSupervisor;
  compensator: CompensationExecutor;
  recovery: RecoveryManager;
  /** 插话总线（Phase 4 切片②：profile 装配在全部就绪后才向它注册策略 hook）。 */
  hooks: HookBus;
  /** record-only / 升级告警缝的收集器（scenario 断言用）。 */
  alerts: AlertRecord[];
  /** 本进程内未能持久化的快照（非空 = "重启可恢复"这条主张对本次运行不成立，CLI 要报出来）。 */
  snapshotFailures: SnapshotFailureRecord[];
  /** runId → 在途 Cell（onCheckpoint 快照索取缝的查找表，切片④）。 */
  bindings: Map<string, { scope: Scope; cell: SupervisedCell }>;
  /** 本运行中 engine 的 Cell（Phase 4 切片④：退出原因码映射为 ENGINE_EXITED）。 */
  engineCells: Set<SupervisedCell>;
  /** 已接线的策略舱（切片④ 回填项 ①）：close 时一并收束，装配审计从这里的 summary 组载荷。 */
  policies: PolicyBinding[];
  close(): Promise<void>;
}

/**
 * 快照根目录（切片⑤ §7 第 2 项，所有者确认）：显式 `--snapshots` 优先，否则由账本根派生
 * **同级** `<账本根名>-snapshots`。为什么不塞进账本根里：`Ledger.scopeOf` 与
 * `cmd-recover.findRunRef` 都按"根下一层就是 agentId"扫描，混进一个保留目录名会污染两处。
 */
export function snapshotDirOf(dataDir: string, explicit?: string): string {
  if (explicit && explicit !== "") return explicit;
  const base = path.basename(path.resolve(dataDir));
  return path.join(path.dirname(path.resolve(dataDir)), `${base}-snapshots`);
}

export interface BuildRuntimeOptions {
  /**
   * 补偿动作 Cell 的材料（ADR-0005「新 Cell」一次性通道）；缺省 = record-only 直闭，无通道。
   * `cellEntry` 缺省 = supervisor 的新生态入口；**承接旧插件时必须给承接层入口**，
   * 否则回滚舱用默认入口装载（它要 `export const tools`），旧插件的
   * `module.exports.compensations` 表根本接不上——回滚闭环走不通（04 稿 §3.3 的接线缺口）。
   */
  actionSpec?: { manifest: LoadedManifest; pluginPath: string; cellEntry?: string };
  /**
   * 运行期授权策略（03 稿 §4 第 2 条）：装配真实/合成报关单的路径必须显式给出 `runPolicy` 的编译结果。
   * 缺省 = 演示策略 `p1`（只服务 Phase 1 场景复演与 benchmark），不再是无人认领的隐式默认。
   */
  policy?: PolicyInput;
  /**
   * 策略插件绑定（切片④ 回填项 ①，ADR-0012）：每个 spec = 一份已过五步校验的
   * `kind:"policy"` 报关单 + 策略模块路径。装配期即完成"起舱 → 探就绪 → 按声明注册"，
   * 抢同一插话点的两份策略**整份拒绝**（不注册、不起舱）。缺省 = 没有策略介入。
   */
  policies?: PolicySpec[];
  /**
   * 快照根目录（切片⑤ §3.2 第 5 步）：缺省 = 由账本根派生同级 `<name>-snapshots`。
   * 不给一个"内存模式"开关——同一能力两种后端就得两条路径都测，而"重启可恢复"这条主张
   * 恰恰只在落盘时才成立（§7 第 2 项被否 B 的理由）。
   */
  snapshotDir?: string;
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
  const ctx = new ToolCatalog();
  const snapshots = new SnapshotStore({ rootDir: snapshotDirOf(dataDir, opts.snapshotDir) });
  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: stubUpstream,
    // 流式时限不在这里开洞：装配出的就是契约 §7 的 30s / 300s 两个默认档
    // （断流的两条计时路径由 `ModelGateway` 自身的注入位在单测里跑，CLI 侧没有对应参数）
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
    hooks: null as unknown as HookBus,
    alerts: [],
    snapshotFailures: [],
    bindings: new Map(),
    engineCells: new Set(),
    policies: [],
    close: async () => undefined,
  };
  // 插话总线在装配期就接线（handler 注册是装配动作，运行期不换装——hooks.ts 既有口径）
  const hookBus = new HookBus(ledger);
  rt.hooks = hookBus;
  rt.scheduler = new Scheduler(
    { ledger, auth, budget, ctx, hooks: hookBus, gateway },
    {
      // 快照索取缝（D3）：CHECKPOINT → STATE_SNAPSHOT_REF → ROUND_ENDED（I3 顺序）
      // 切片⑤ 把内容改成落盘：**先内容成功、后记账本引用**——账本绝不留下指向不存在内容的 ref。
      // 落盘失败不在这里抛给内核（调度器对该缝的既有语义是"尽力而为"，Phase 1 D3 定案），
      // 而是落进 rt.snapshotFailures 由交付入口报成可见失败——不静默跳过，也不新增错误码。
      onCheckpoint: async (r, info) => {
        const b = rt.bindings.get(r.runId);
        if (!b) return;
        const state = await b.cell.pullSnapshot();
        let meta: { ref: string; version: number } | null;
        try {
          meta = await snapshots.save(
            { agentId: r.agentId, sessionId: r.sessionId },
            info.round,
            state,
          );
        } catch (err) {
          rt.snapshotFailures.push({
            runId: r.runId,
            round: info.round,
            message: err instanceof Error ? err.message : String(err),
          });
          return; // 不写 STATE_SNAPSHOT_REF：没有内容的引用会误导恢复
        }
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
      if (!ref) return;
      // engine Cell 的退出在 reasonCode 上与普通能力舱区分（R8 / 03 稿 E6）：
      // 契约错误码集合不变，变的是载荷级原因码。
      const reasonCode = rt.engineCells.has(e.cell) ? "ENGINE_EXITED" : e.reasonCode;
      void rt.scheduler.abort(ref.runId, reasonCode, e.message);
    },
  });
  /**
   * 策略接线（切片④ 回填项 ①）：装配期一次做完；失败即抛，不留半活的策略舱。
   * 子进程只能跑 dist（与 `assertDist` 同一约定）——要绑策略而入口缺失就明确报错。
   */
  if ((opts.policies ?? []).length > 0 && !existsSync(policyCellEntryPath)) {
    throw new Error(`policy cell entry missing: ${policyCellEntryPath} — run "pnpm build" first`);
  }
  rt.policies = await wirePolicies({
    supervisor: rt.supervisor,
    bus: hookBus,
    specs: opts.policies ?? [],
    policyEntryPath: policyCellEntryPath,
  });
  rt.compensator = new CompensationExecutor(
    opts.actionSpec
      ? {
          ledger,
          // 补偿动作通道 = 一次性新补偿 Cell：同插件 spawn → compensation.exec → dispose（A4 rig 同构）
          factory: async (): Promise<CompensationActionCell> => {
            const spec = opts.actionSpec as {
              manifest: LoadedManifest;
              pluginPath: string;
              cellEntry?: string;
            };
            const cell = rt.supervisor.spawnCell({
              manifest: spec.manifest,
              pluginPath: spec.pluginPath,
              // 旧插件走承接层入口（缺省 = 新生态默认入口）：与起 run 用的是同一个入口位
              cellEntry: spec.cellEntry,
            });
            const timeout =
              (spec.manifest.resources.toolCallTimeoutMs ?? 0) + rt.supervisor.graceMs + 1_000;
            return {
              // 走 cell.call：补偿动作也是一次在途通道调用，收尾要等它收束（切片⑤ §3.3 第 2 步）
              exec: (input) => cell.call("compensation.exec", input, timeout),
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
  /** 会话内运行序号（Phase 5 切片②；缺省不写，账本形状与 Phase 4 一致）。 */
  sessionRun?: number;
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
  // 装配审计追加 policies（ADR-0012 决策 6）：**没绑策略时不写这个字段**，
  // 于是账本形状与 Phase 1 的旧样例逐字节一致（B7⑤ 的兼容性口径靠这种取舍保住）。
  const assembly =
    rt.policies.length > 0
      ? { ...opts.manifest.record, policies: rt.policies.map((b) => b.summary) }
      : opts.manifest.record;
  const { done } = rt.scheduler.start({
    ref,
    subject: scope.agentId,
    executor: cell.executor,
    driver: opts.driver,
    assembly,
    compensator: opts.withCompensator
      ? (mode) => rt.compensator.compensate(ref, { mode })
      : undefined,
    recoveredFrom: opts.recoveredFrom,
    ...(opts.sessionRun !== undefined ? { sessionRun: opts.sessionRun } : {}),
  });
  cell.attachRun(ref);
  rt.bindings.set(ref.runId, { scope, cell });
  return { ref, cell, done };
}

/** 关闭：收束全部在途 Cell + 落盘账本（standards/04 确定性释放）。 */
export async function closeRuntime(rt: Runtime): Promise<void> {
  await Promise.allSettled([...rt.bindings.values()].map((b) => b.cell.drainAndReap()));
  // 策略舱不属于任何 run（不进 bindings），但它同样是进程资源：收束覆盖所有 spawn 源（P-003）
  await Promise.allSettled(rt.policies.map((b) => b.cell.drainAndReap()));
  rt.bindings.clear();
  rt.engineCells.clear();
  rt.policies = [];
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
