/**
 * 切片①集成测试共享 rig —— 用**真实子进程 Cell** 承载旧形状插件（02 稿 §4 seam 的落地形状）。
 *
 * 与 Phase 1 各集成测试的差异只有一处：`spawnCell({ cellEntry })` 换成承接层的入口，
 * 于是舱内装载的是 CommonJS 旧插件、旧 ctx 由承接层注入；其余接线顺序与 P-002 的四类错一致
 * （spawn → serve → alloc → start → attachRun，参数位与 hook 时序都在这一处收敛）。
 *
 * driver 是**断言式**的（02 稿 §7）：它每轮只从内核送进来的可见表里选工具，预期工具缺席即记违规——
 * 这样"可见性一半有没有真被填上"无从作假（Phase 1 的脚本 driver 直接点名工具，看不见这一半）。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AuthRule,
  LedgerEvent,
  ModelUpstream,
  RunDriver,
  RunRef,
  RunStatus,
  Scope,
  ToolEntry,
} from "@keel/core";
import {
  Authorizer,
  Budgeter,
  ContextManager,
  HookBus,
  Ledger,
  ModelGateway,
  Scheduler,
  type CompensationScope,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  CompensationExecutor,
  EffectTracker,
  ProcessIsolationProvider,
  SupervisedCell,
  manifestAuthRules,
  serveCellChannel,
  type CompensationActionCell,
  type CompensationTemplateDecl,
  type LoadedManifest,
  type PermissionDecl,
} from "@keel/host";

export const repoRoot = process.cwd();
/** 承接层的 Cell 进程入口（旧插件专用；子进程只跑 dist，见 P-002 规则 4）。 */
export const cordisCellEntry = path.join(
  repoRoot,
  "packages",
  "cordis-adapter",
  "dist",
  "cell-entry.js",
);
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

/**
 * 一轮的预期。
 * - visible：本轮可见表应含的条目，写 `"name"` 或 `"name@version"`（缺席即违规）；
 * - absent：本轮必须看不到的名字；
 * - call：本轮执行的工具；
 * - awaitCellExit：决策前先等本 Cell 进程退出（有截止）——用来把"舱内异步逃逸异常"这类
 *   只能事后浮现的事实收成一条确定断言，而不是靠运气抢在收束之前观察到它；
 * - done：本轮收束。
 */
export interface RoundPlan {
  visible?: string[];
  absent?: string[];
  call?: { tool: string; params?: unknown };
  awaitCellExit?: boolean;
  /**
   * 切片③（B3 的 #9 链）：本轮以 abort 收束——`RUN_FAILED` 是补偿状态机的触发点之一
   * （`failRun` 尽力收尾 = compensate("run")），用来观察"报关过 → 舱内失败 → 补偿真的执行"。
   */
  abort?: { code: string; message?: string };
  done?: boolean;
}

export interface LegacyRunSpec {
  agentId: string;
  sessionId: string;
  runId: string;
  /** 旧插件文件（.cjs）。 */
  pluginPath: string;
  /** manifest 声明（缺省 = 只声明 tool.provide）；给 [] 即"未报关"负例。 */
  caps?: PermissionDecl[];
  /**
   * 补偿模板（切片③ #9）：`effect.declare` 的 C-M1 对照表就来自这里——
   * 没报关的 effectKind 会被内核拒且不留副作用。
   */
  templates?: RawTemplate[];
  /** 接补偿执行器（run 模式 = 全 Run 回滚，动作舱用**承接层入口**装载旧插件的补偿表）。 */
  compensate?: boolean;
  toolCallTimeoutMs?: number;
  plan: RoundPlan[];
  /**
   * Cell 入口：缺省 "legacy"（承接层入口，旧形状插件）；"default" = 内核默认入口（新生态插件）。
   * 两者共用同一 supervisor / 同一策略，用于证明"换入口不改隔离与生命周期语义"（02 稿 §4）。
   */
  entry?: "legacy" | "default";
  /**
   * 激活屏障要等到位的条目（缺省 = 首轮 plan 的 visible；`[]` = 不等）。
   * 复用同一 scope 的第二个 run 必须写全 `"name@version"`——只写名字会在上一 run 留下的
   * 旧版本上立刻满足屏障，把"本舱注册到了 v3"这件事等成"分区里早就有 flip"。
   * 负例（注册被拒 → 舱内崩溃）也靠它：等不到时以"舱已退出/通道已坏"为终止条件，
   * 让 run 在**存活期间**看见崩溃，而不是起一个对着死舱的 run。
   */
  boot?: string[];
}

export interface RunProbe {
  ref: RunRef;
  cell: SupervisedCell;
  /** 每轮实际看到的可见表指纹（排序后的 name@version；激活屏障的空转轮不计入）。 */
  seen: string[][];
  /** 违规（空 = 一切符合预期；违规不抛错，免得把 run 本身搞花）。 */
  violations: string[];
  /** 每轮动作的结果摘要（来自 ToolExecutor 的落账载荷由测试另读账本核对）。 */
  results: unknown[];
  /** 为等激活空转了几轮（诊断用：屏障不该长期占用）。 */
  activationRounds: number;
  /** 激活屏障是否因超时/舱退而放弃等待（负例路径的证据位）。 */
  barrierGaveUp: boolean;
  /** 补偿重派缝（仅 `compensate: true` 的 run 有）：B3 用它证"闭环后再派不重复执行"。 */
  compensate?: () => Promise<boolean>;
  done: Promise<RunStatus>;
}

export function fingerprint(entries: ToolEntry[]): string[] {
  return entries.map((t) => `${t.name}@${t.schemaVersion}`).sort();
}

export function names(entries: ToolEntry[]): string[] {
  return entries.map((t) => t.name).sort();
}

/** 报关单里的原始补偿模板形状（`class` 是输入侧字段名，与 assembler 一致）。 */
export interface RawTemplate {
  kind: string;
  class: CompensationTemplateDecl["compensationClass"];
  action: { type: "plugin" | "builtin"; ref: string };
  idempotency: CompensationTemplateDecl["idempotency"];
  probe?: { ref: string };
}

/** 组装旧插件用的 manifest（切片②才引入合成路径，本片按"已报关"给声明）。 */
export function legacyManifest(
  caps: PermissionDecl[] = [{ cap: "tool.provide" }],
  toolCallTimeoutMs = 5_000,
  templates: RawTemplate[] = [],
): LoadedManifest {
  return new Assembler({ schema: manifestSchema }).assemble({
    kind: "capability",
    meta: { name: `cordis-${caps.length}`, version: "1.0.0", title: "legacy", description: "x" },
    permissions: caps,
    resources: { toolCallTimeoutMs },
    compensation: { templates },
    compat: { keelContract: "^1.0" },
  });
}

export function fixtureFile(name: string): string {
  return path.join(repoRoot, "tests", "fixtures", "cordis-plugins", name);
}

/** fixtures 根目录下的**新生态**插件（.mjs，默认入口装载）——对照用，不参与零改动扫描。 */
export function coreFixtureFile(name: string): string {
  return path.join(repoRoot, "tests", "fixtures", name);
}

/** 激活屏障的节奏与截止：子进程起飞实测 <1s，截止只在该红的样本上才会跑到。 */
const ACTIVATION_POLL_MS = 25;
const ACTIVATION_DEADLINE_MS = 6_000;
/** 舱退出信号 → abort 缝落 RUN_FAILED 的落地余量（同一次退出事件里同步发起，但写账是异步的）。 */
const ABORT_SETTLE_MS = 100;
const READINESS_PROBE_TOOL = "__keel_readiness_probe__";
const READINESS_PROBE_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 屏障条目 = `"name"`（只要存在）或 `"name@version"`（存在且就是这一版）。 */
function bootSatisfied(tools: ToolEntry[], boot: string[]): boolean {
  const fp = fingerprint(tools);
  return boot.every((b) =>
    b.includes("@") ? fp.includes(b) : fp.some((e) => e.split("@")[0] === b),
  );
}

/**
 * 默认入口的就绪探测：一次 tool.exec 探测得到应答即"舱已装载"（main.ts 在 import 之后
 * 才装 serve 处理器，且静态工具同步登记完才回到事件循环）。请求会在舱内一直排着，
 * 所以这是一次真正的屏障而不是轮询；舱死则通道 break → 立即拒绝。
 */
async function probeCellAlive(cell: SupervisedCell): Promise<boolean> {
  try {
    await cell.conn.request(
      "tool.exec",
      { tool: READINESS_PROBE_TOOL, params: {} },
      READINESS_PROBE_TIMEOUT_MS,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 一套完整内核 + 若干旧插件 run。close() 负责收束 Cell 与账本（standards/04 §3 确定性释放；
 * ADR-0009：Ledger 实例一律登记，不留浮空句柄）。
 *
 * `upstream` 可注入（切片③ F8）：B3 的 #6 要观察"预扣/实结/同 reqId 重放不重复计费"，
 * 那就必须能数清**上游真的被打了几次**——缺省仍是零用量桩（既有主张不变）。
 */ export function createLegacyRig(
  opts: { log?: (line: string) => void; upstream?: ModelUpstream } = {},
) {
  const instances: Ledger[] = [];
  const cells: SupervisedCell[] = [];
  /** 补偿升级告警缝（B3 的 #9 观察位）。 */
  const alerts: { runId: string; effectId: string; escalated: boolean }[] = [];
  let dir = "";
  let ledger!: Ledger;
  let ctxMgr!: ContextManager;
  let scheduler!: Scheduler;
  let supervisor!: CellSupervisor;
  let auth!: Authorizer;
  let budget!: Budgeter;
  let gateway!: ModelGateway;

  async function setup(policyRules: AuthRule[]): Promise<void> {
    dir = await mkdtemp(path.join(tmpdir(), "keel-b1-"));
    ledger = new Ledger({ rootDir: dir });
    instances.push(ledger);
    auth = new Authorizer({ version: "p-b1", allow: policyRules }, ledger);
    budget = new Budgeter(ledger);
    ctxMgr = new ContextManager();
    gateway = new ModelGateway({
      ledger,
      auth,
      budget,
      upstream: opts.upstream ?? {
        invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }),
      },
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
      // 默认入口 = 新生态；旧插件走 per-spawn cellEntry 覆盖（02 稿 §4）
      cellEntryPath: path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js"),
      toolKillGraceMs: 2_000,
      onCellExit: (e) => {
        const ref = e.cell.ref;
        if (ref) void scheduler.abort(ref.runId, e.reasonCode, e.message);
      },
    });
  }

  /** 起一个旧插件 run：spawn（换入口）→ serve → alloc → start（断言式 driver）→ attachRun。 */
  function runLegacy(spec: LegacyRunSpec): RunProbe {
    const scope: Scope = { agentId: spec.agentId, sessionId: spec.sessionId };
    const ref: RunRef = { ...scope, runId: spec.runId };
    const manifest = legacyManifest(spec.caps, spec.toolCallTimeoutMs, spec.templates);
    const tracker = new EffectTracker({ ledger });
    const cell = supervisor.spawnCell({
      manifest,
      pluginPath: spec.pluginPath,
      cellEntry: spec.entry === "default" ? undefined : cordisCellEntry,
      tracker,
    });
    cells.push(cell);
    serveCellChannel(
      cell.conn,
      {
        scope,
        ref,
        subject: scope.agentId,
        templates: new Map(manifest.templates.map((t) => [t.kind, t])),
      },
      { ledger, auth, budget, ctx: ctxMgr, gateway, tracker },
    );
    ctxMgr.alloc(scope);

    const probe: RunProbe = {
      ref,
      cell,
      seen: [],
      violations: [],
      results: [],
      activationRounds: 0,
      barrierGaveUp: false,
      done: null as never,
    };
    let round = 0;
    /* ── 激活屏障 ────────────────────────────────────────────────────────────
     * 子进程起飞要上百 ms，而调度轮次是瞬时的：不起屏障就会在第 1 轮读到空表，
     * 那既不是缺陷也证明不了主张。生产宿主的对应物是"装配就绪之后才起 run"（切片②）。
     * 两种入口各用自己的**既有**信号，不新增协议帧：
     *   旧入口   = 内核分区里出现了 activation 注册的名字（注册帧 → 分区写 = 唯一可观测凭据）；
     *   默认入口 = 一次 tool.exec 探测得到应答——main.ts 里 startCell() 在动态 import 之后、
     *              静态工具登记之前同步完成，所以第一个应答只可能来自"插件已装载"的舱。
     * 放弃等待的两个条件都是证据而不是掩盖：舱已退出（负例：注册被拒 → 崩溃）或超过截止。
     */
    const bootNames = spec.boot ?? spec.plan[0]?.visible ?? [];
    const useProbe = spec.entry === "default";
    let barrier = bootNames.length > 0 || useProbe;
    let waitedMs = 0;
    const driver: RunDriver = {
      decide: async (c) => {
        if (barrier) {
          const ready = useProbe ? await probeCellAlive(cell) : bootSatisfied(c.tools, bootNames);
          if (ready) {
            barrier = false;
          } else if (
            cell.phase === "exited" ||
            cell.conn.isClosed ||
            waitedMs >= ACTIVATION_DEADLINE_MS
          ) {
            probe.barrierGaveUp = true;
            barrier = false; // 继续按 plan 走：违规与账本自己会把这条路讲清楚
          } else {
            probe.activationRounds += 1;
            waitedMs += ACTIVATION_POLL_MS;
            await sleep(ACTIVATION_POLL_MS);
            return { summary: `${spec.runId} await-activation`, actions: [] };
          }
        }
        const plan = spec.plan[round] ?? { done: true };
        round += 1;
        if (plan.awaitCellExit) {
          // 等舱退出（截止 = ACTIVATION_DEADLINE_MS），再留一段让 abort 缝把 RUN_FAILED 落下去
          const t0 = Date.now();
          while (
            cell.phase !== "exited" &&
            !cell.conn.isClosed &&
            Date.now() - t0 < ACTIVATION_DEADLINE_MS
          ) {
            await sleep(ACTIVATION_POLL_MS);
          }
          await sleep(ABORT_SETTLE_MS);
          return { done: true, summary: `${spec.runId} awaited-exit` };
        }
        const got = names(c.tools);
        probe.seen.push(fingerprint(c.tools));
        for (const want of plan.visible ?? []) {
          if (!got.includes(want)) {
            probe.violations.push(
              `round ${c.round}: expected visible "${want}", got [${got.join(", ")}]`,
            );
          }
        }
        for (const bad of plan.absent ?? []) {
          if (got.includes(bad))
            probe.violations.push(`round ${c.round}: "${bad}" must be invisible`);
        }
        if (plan.done) return { done: true, summary: `${spec.runId}-end` };
        if (plan.abort) {
          // **不 await**：abort() 返回的是 done，而 done 只能在本轮收束之后落定——
          // 此刻 decide 正被轮循环 await，等它就是自锁（standards/04 的 await 位纪律）。
          void scheduler.abort(ref.runId, plan.abort.code, plan.abort.message);
          return { done: true, summary: `${spec.runId} abort-requested` };
        }
        if (plan.call) {
          return {
            summary: `${spec.runId} r${c.round}`,
            actions: [{ kind: "tool", tool: plan.call.tool, params: plan.call.params }],
          };
        }
        return { done: true, summary: `${spec.runId}-idle` };
      },
    };

    /**
     * 补偿执行器（B3 的 #9 链）：动作舱 = **同插件的新 Cell**，且必须走承接层入口——
     * 默认入口要 `export const tools`，旧插件的 `module.exports.compensations` 表接不上
     * （04 稿 §3.3 的接线缺口；apps/keel 的 `actionSpec.cellEntry` 是同一处的生产形态）。
     */
    let compensator: ((mode: CompensationScope) => Promise<boolean>) | undefined;
    if (spec.compensate) {
      const executor = new CompensationExecutor(
        {
          ledger,
          factory: async (): Promise<CompensationActionCell> => {
            const actionCell = supervisor.spawnCell({
              manifest,
              pluginPath: spec.pluginPath,
              cellEntry: cordisCellEntry,
            });
            cells.push(actionCell);
            const timeout =
              (manifest.resources.toolCallTimeoutMs ?? 0) + supervisor.graceMs + 1_000;
            return {
              exec: (input) => actionCell.conn.request("compensation.exec", input, timeout),
              dispose: () => actionCell.drainAndReap(),
            };
          },
        },
        {
          onAlert: async (info) =>
            void alerts.push({
              runId: info.ref.runId,
              effectId: info.effectId,
              escalated: info.escalated,
            }),
        },
      );
      compensator = (mode) => executor.compensate(ref, { mode });
      probe.compensate = () => executor.compensate(ref, { mode: "run" });
    }

    const started = scheduler.start({
      ref,
      subject: scope.agentId,
      executor: cell.executor,
      driver,
      assembly: manifest.record,
      compensator,
    });
    /**
     * 静默起舱失败的收口（切片③ 踩到过一次）：run 在**装载屏障还没满足时**就失败，
     * plan 的 visible/absent 一条都不会跑，违规表因此是空的——测试会"通过前提"然后
     * 在后面的断言上莫名失败。这里把它变成一条明确的违规，让归因停在真正的原因上。
     */
    probe.done = started.done.then((st) => {
      if (barrier && st.state === "failed") {
        probe.violations.push(
          `run ${spec.runId} failed while the activation barrier was still up (reason=${st.reasonCode ?? "?"})`,
        );
      }
      return st;
    });
    cell.attachRun(ref);
    opts.log?.(`run ${spec.runId} started (plugin=${path.basename(spec.pluginPath)})`);
    return probe;
  }

  async function readRun(runId: string): Promise<LedgerEvent[]> {
    try {
      return (await ledger.read({ runId })).events;
    } catch {
      return []; // 尚无任何事件（负路径：崩溃在首事件之前）
    }
  }

  async function close(): Promise<void> {
    await Promise.allSettled(cells.map((c) => c.drainAndReap()));
    await Promise.allSettled(instances.map((l) => l.close()));
    if (dir) await rm(dir, { recursive: true, force: true });
  }

  return {
    setup,
    runLegacy,
    readRun,
    close,
    get ctx() {
      return ctxMgr;
    },
    get ledger() {
      return ledger;
    },
    /** 本 rig 的账本临时目录（样本用它的绝对路径做副作用标记得到的载体；setup 之后才有值）。 */
    get dir() {
      return dir;
    },
    /** 补偿升级告警缝（B3 观察位：升级 = 补偿自身失败，不该静默）。 */
    alerts,
  };
}

/** 由声明编译策略 + 本 rig 固定的"工具执行放行"（tool.invoke 是 Core→Cell 方向，不属本片扩展面）。 */
export function policyFor(
  manifest: LoadedManifest,
  subject: string,
  extra: AuthRule[] = [],
): AuthRule[] {
  return [
    ...manifestAuthRules(manifest, subject),
    { subject: "*", action: "tool.invoke", resource: "*" },
    ...extra,
  ];
}
