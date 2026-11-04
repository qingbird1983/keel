/**
 * Cell Supervisor —— Host Layer（架构总览 §4.2）+ ADR-0005：
 * - 生命周期：creating → ready → running → halting → exited → reaped
 * - 退出三分类：clean（exit 0）/ crash（非零退出或致命信号）/ killed（Supervisor 强杀）；
 *   经 onCellExit 通知宿主 → scheduler.abort 落 RUN_FAILED（契约 §4.1 注记④）。
 * - toolCallTimeoutMs 硬强制的后盾（C-D3）：工具调用超时 + 宽限仍无响应 → kill（killed）。
 * - **收尾（drain）次序（切片⑤ §3.3，B7③）**：进入 halting 即拒绝新动作（`SCHED/BACKPRESSURE`，
 *   既有准入码，不新开）→ 等在途通道调用收束（每个调用自带超时与强杀计时，不引入第三个时限数）
 *   → 宽限 `toolKillGraceMs` 到点仍未收束则 kill → reaped。产物是 `DrainOutcome`（返回值，
 *   不是账本事件——§5 事件类型是封闭集合，收尾是宿主侧生命周期动作）。
 * - executor 通道绑定：通道死 → error-result 回落（终态统一由 abort 缝落，保证原因码确定）；
 *   切片④：返回前经效果追踪器结算 EFFECT_SETTLED（落点序 EFFECT_SETTLED → TOOL_RESULT）。
 * - 快照（D3，切片④）：pullSnapshot 于轮边界索取（onCheckpoint 缝）；无快照面 = 无状态。
 */

import { KeelError, type RunRef, type ToolExecutor } from "@keel/core";
import {
  ChannelError,
  FrameConn,
  TRANSPORT_TIMEOUT,
  type ToolExecResult,
} from "@keel/cell-runtime";
import type { CellProcess, IsolationProvider } from "./isolation.js";
import { sanitizedEnv } from "./isolation.js";
import { deriveWorkspaceRoot } from "./workspace.js";
import type { LoadedManifest } from "./assembler.js";
import type { ManagedCell } from "./assembly-manager.js";
import type { EffectTracker } from "./effects.js";
import { compileGovernancePlan } from "./governance.js";

export type CellExitClass = "clean" | "crash" | "killed";
export type CellPhase = "creating" | "ready" | "running" | "halting" | "exited" | "reaped";

/** ADR-0005 原因码（载荷级字符串，契约 §4.1 注记④）。 */
export const CELL_EXIT_REASON: Record<CellExitClass, string> = {
  clean: "CELL/CLEAN-EXIT",
  crash: "CELL/CRASH",
  killed: "CELL/KILLED",
};

export interface CellExit {
  /** 退出源 Cell（宿主胶水经 cell.ref 定位 runId → scheduler.abort）。 */
  cell: SupervisedCell;
  exitClass: CellExitClass;
  reasonCode: string;
  message: string;
}

/**
 * 收尾产物（切片⑤ §3.3）：**返回值不是账本事件**——事件类型是封闭集合（契约 §5），
 * 而"在途动作因收尾而结果未知"这件事已由既有路径留痕（settleEffects 写 `EFFECT_SETTLED{unknown}`）。
 */
export interface DrainOutcome {
  /** 进入 halting 时还在途的通道调用数。 */
  inFlightAtStart: number;
  /** 收尾期间被拒绝的新调用数（`SCHED/BACKPRESSURE`）。 */
  refused: number;
  /** 在宽限期内自己收束掉的在途调用数。 */
  settled: number;
  /** true = 宽限期到点仍有人在途（因此强杀）；false = 全部自然收束。 */
  timedOut: boolean;
  /** 本次收尾是否走到 kill（已自然退出的舱不再补刀）。 */
  killed: boolean;
  /** 收尾耗时（ms，仅供观测与测试下界断言）。 */
  waitedMs: number;
}

export interface SupervisorOptions {
  provider: IsolationProvider;
  /** Cell 进程入口（@keel/cell-runtime dist main.js 绝对路径）。 */
  cellEntryPath: string;
  /** 失控强杀宽限：toolCallTimeoutMs 后仍未响应 → 再等此时长 → kill（默认 5s）。 */
  toolKillGraceMs?: number;
  /** 可选 Node 权限模型参数（ADR-0019；默认不启用，不是沙箱）。 */
  nodePermissionArgs?: string[];
  onCellExit?: (exit: CellExit) => void;
}

/** 默认迁移钩超时：A5 序列在 run.start 5s 窗口内（契约 §7）。 */
const MIGRATE_TIMEOUT_MS = 5_000;

/**
 * `engine.step` 的一步时限（Phase 4 切片④，04 稿 R7 / ADR-0023）：取契约 §7 既有的
 * **300s 档**（一步内最多含一次流式模型调用），不新增数字。
 */
export const ENGINE_STEP_TIMEOUT_MS = 300_000;

export class CellSupervisor {
  private readonly provider: IsolationProvider;
  private readonly cellEntryPath: string;
  private readonly toolKillGraceMs: number;
  private readonly nodePermissionArgs: string[] | undefined;
  private readonly onCellExit?: (exit: CellExit) => void;

  constructor(opts: SupervisorOptions) {
    this.provider = opts.provider;
    this.cellEntryPath = opts.cellEntryPath;
    this.toolKillGraceMs = opts.toolKillGraceMs ?? 5_000;
    this.nodePermissionArgs = opts.nodePermissionArgs;
    this.onCellExit = opts.onCellExit;
  }

  /** spawn Cell 进程并绑定帧通道；Cell ↔ Run 一一对应（run 建立时 attachRun）。 */
  spawnCell(spec: {
    manifest: LoadedManifest;
    pluginPath: string;
    tracker?: EffectTracker;
    /**
     * 本 Cell 的进程入口（切片① seam，ADR-0010 决策 8）：缺省 = supervisor 的 `cellEntryPath`
     * （新生态插件 = @keel/cell-runtime 入口）；承接存量插件时宿主传承接层自带入口。
     * 旧插件入口本身即"这是旧插件"的信号；其报关单没有 governance，bootstrap 载荷形状不变。
     */
    cellEntry?: string;
    /**
     * bootstrap 的**追加字段**：策略舱 `{hooks}`（切片④）、能力舱 `{governance}`（ADR-0015
     * 由 `SupervisedCell` 自动追加），入口据此校验导出集合 / 织入切面。
     * 无对应声明时载荷就是 `{pluginPath, toolCallTimeoutMs}`，既有入口不受影响。
     */
    bootstrapExtra?: Record<string, unknown>;
  }): SupervisedCell {
    return new SupervisedCell({
      supervisor: this,
      manifest: spec.manifest,
      pluginPath: spec.pluginPath,
      tracker: spec.tracker,
      cellEntry: spec.cellEntry,
      bootstrapExtra: spec.bootstrapExtra,
    });
  }

  /* internal */
  spawnProcess(bootstrap: string, entryPath?: string, opts?: { cwd?: string }): CellProcess {
    return this.provider.spawn({
      entryPath: entryPath ?? this.cellEntryPath,
      bootstrap,
      env: sanitizedEnv(),
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(this.nodePermissionArgs ? { nodePermissionArgs: this.nodePermissionArgs } : {}),
    });
  }

  get graceMs(): number {
    return this.toolKillGraceMs;
  }

  get exitSink(): ((exit: CellExit) => void) | undefined {
    return this.onCellExit;
  }
}

export class SupervisedCell implements ManagedCell {
  phase: CellPhase = "creating";
  /** Cell ↔ Run 一一对应（契约 §3.2）；run 建立前为 null。 */
  ref: RunRef | null = null;
  /** Host 侧通道端点（同实例承载 Cell 可见面服务 serveCellChannel）。 */
  readonly conn: FrameConn;
  readonly manifest: LoadedManifest;

  /** Host 侧就绪凭据（wireCell 探到应答后置位）；未就绪的舱不做 dispose 等待（R4）。 */
  hostReady = false;

  private readonly supervisor: CellSupervisor;
  private readonly process: CellProcess;
  private readonly tracker: EffectTracker | null;
  private killRequested = false;
  private exitResult: CellExit | null = null;
  private notified = false;
  private readonly exitWaiters: Array<(e: CellExit) => void> = [];
  /** 在途通道调用（drain 的等待对象，切片⑤ §3.3 第 2 步）。 */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** 收尾期间被拒的新调用计数（进 `DrainOutcome.refused`）。 */
  private drainRefused = 0;

  constructor(params: {
    supervisor: CellSupervisor;
    manifest: LoadedManifest;
    pluginPath: string;
    tracker?: EffectTracker;
    cellEntry?: string;
    bootstrapExtra?: Record<string, unknown>;
  }) {
    this.supervisor = params.supervisor;
    this.manifest = params.manifest;
    this.tracker = params.tracker ?? null;
    // 治理计划随 spawn 一次送达（ADR-0015）：所有起舱路径（run / 热装配 / fixture）共用，
    // 无声明不加字段——既有载荷形状不变。显式 bootstrapExtra 可覆盖（测试/特殊入口）。
    const governance = compileGovernancePlan(params.manifest.governance);
    // engine 的报关单段随 bootstrap 一次送达（Phase 4 切片④）：模块不自报模型名/工具清单。
    const engine = params.manifest.kind === "engine" ? params.manifest.engine : null;
    const boot = JSON.stringify({
      pluginPath: params.pluginPath,
      toolCallTimeoutMs: params.manifest.resources.toolCallTimeoutMs ?? 0,
      ...(governance ? { governance } : {}),
      ...(engine ? { engine } : {}),
      ...params.bootstrapExtra, // 追加而非改写：策略舱 hooks 与能力舱 governance 是同一 seam 的两个字段
    });
    this.process = this.supervisor.spawnProcess(
      boot,
      params.cellEntry,
      // R5（ADR-0019）：唯一写根 = 工作区 cwd；多根/无根不猜，保持默认 cwd
      (() => {
        const root = deriveWorkspaceRoot(params.manifest.permissions);
        return root ? { cwd: root } : undefined;
      })(),
    );
    this.conn = new FrameConn({ input: this.process.stdout, output: this.process.stdin });
    this.phase = "ready";
    this.process.onExit(({ code }) => {
      if (this.exitResult) return;
      const exitClass: CellExitClass = this.killRequested
        ? "killed"
        : code === 0
          ? "clean"
          : "crash";
      this.exitResult = {
        cell: this,
        exitClass,
        reasonCode: CELL_EXIT_REASON[exitClass],
        message: `cell process exited (${exitClass}), code=${code}`,
      };
      this.phase = "exited";
      for (const w of this.exitWaiters.splice(0)) w(this.exitResult);
      // 通道关闭路径已即时通知过（provisional）则不再重复
      if (!this.notified) this.notify(this.exitResult);
    });
    // 第一信号 = 通道关闭（Windows 上 exit 事件滞后于 stdout 结束数十 ms，
    // 不能等它——run 会在 abort 落地前跑完）。killRequested 同步可知，分类立即成立。
    void this.conn.done.then(() => this.onChannelClosed());
  }

  /** 通道死亡：立即通知宿主（abort 缝）；此进程死亡之外的 break 不会发生（宿主不主动 break）。 */
  private onChannelClosed(): void {
    if (this.exitResult) {
      this.notify(this.exitResult);
      return;
    }
    // 退出事件未至即通道死：非 Supervisor 受控死亡按 crash 语义（ADR-0005；受控 kill → killed）
    const exitClass: CellExitClass = this.killRequested ? "killed" : "crash";
    this.notify({
      cell: this,
      exitClass,
      reasonCode: CELL_EXIT_REASON[exitClass],
      message: `cell channel closed (${exitClass} per killRequested; exit event pending)`,
    });
  }

  private notify(exit: CellExit): void {
    if (this.notified) return;
    this.notified = true;
    this.supervisor.exitSink?.(exit);
  }

  /**
   * 带在途登记的通道调用（切片⑤ §3.3）：executor / 快照索取 / 迁移钩 / 补偿动作 / 策略插话
   * 都走这里，drain 等的就是这个集合。
   * 收尾中的舱**拒绝新调用**（`SCHED/BACKPRESSURE`，契约 §6 既有准入码——"退避后是"），
   * 不新开 `CELL/DRAINING`：语义是准入拒绝，不是通道坏了。
   */
  call<T = unknown>(op: string, params: unknown, timeoutMs: number): Promise<T> {
    // cell.dispose 是收尾专用调用：halting 期间仍放行，其余新调用一律拒绝。
    if (
      op !== "cell.dispose" &&
      (this.phase === "halting" || this.phase === "exited" || this.phase === "reaped")
    ) {
      this.drainRefused += 1;
      return Promise.reject(
        new KeelError("SCHED/BACKPRESSURE", `cell draining: ${op} not accepted`, { op }),
      );
    }
    // 显式标注是必要的：常量自引用（闭包里删自己）没有标注就成了循环推断（TS7022）
    const tracked: Promise<T> = this.conn.request<T>(op, params, timeoutMs).finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  /** 工具执行通道（调度器 RunManifest.executor 绑定）。 */
  readonly executor: ToolExecutor = async (invocation) => {
    if (this.exitResult) {
      return {
        status: "error",
        error: { code: "TRANSPORT/BADFRAME", message: "cell already exited" },
      };
    }
    // 收尾中（切片⑤ §3.3 第 1 步）：**落成 error 结果而不是抛错**——抛出去会被调度器当成
    // 未预期内部错误而 fail-stop，而"舱在收尾、这笔先别打"是一次正常的准入拒绝。
    if (this.phase === "halting" || this.phase === "reaped") {
      this.drainRefused += 1;
      return {
        status: "error",
        error: { code: "SCHED/BACKPRESSURE", message: "cell draining: no new tool.exec accepted" },
      };
    }
    // 失控强杀计时（C-D3 + ADR-0005 killed）：超时 + 宽限仍无响应 → kill
    const killTimer = setTimeout(
      () => void this.kill(),
      (this.manifest.resources.toolCallTimeoutMs ?? 0) + this.supervisor.graceMs,
    );
    try {
      // 请求超时 ≥ 强杀计时：正常路径 cell 侧先回 timeout 结果；强杀路径由通道关闭收尾
      const r = await this.call<ToolExecResult>(
        "tool.exec",
        invocation,
        (this.manifest.resources.toolCallTimeoutMs ?? 0) + this.supervisor.graceMs + 1_000,
      );
      await this.settleEffects(r.status, r.status === "ok" ? undefined : r.error);
      return r; // 结构兼容（cell-runtime 结果形 ⊇ 调度器 executor 返回形）
    } catch (err) {
      if (err instanceof ChannelError && err.code === TRANSPORT_TIMEOUT) {
        const fallback = {
          status: "timeout" as const,
          error: { code: TRANSPORT_TIMEOUT, message: err.message },
        };
        await this.settleEffects(fallback.status, fallback.error);
        return fallback;
      }
      // 通道死（进程退出）：error-result 回落，RUN_FAILED 由 abort 缝统一落（原因码确定）
      const fallback = {
        status: "error" as const,
        error: { code: "TRANSPORT/BADFRAME", message: "cell channel closed" },
      };
      await this.settleEffects(fallback.status, fallback.error);
      return fallback;
    } finally {
      clearTimeout(killTimer);
    }
  };

  /**
   * 调用窗口结算（切片④）：本 run 全部未结效果写 EFFECT_SETTLED（ok→done，
   * error/timeout→unknown 保守）。崩溃残留的未结效果不入此路径——账本留 declared 未闭环，
   * 恢复投影保守并入（ADR-0004 先核对再续跑）。
   */
  private async settleEffects(status: "ok" | "error" | "timeout", error?: unknown): Promise<void> {
    if (!this.tracker || !this.ref) return;
    await this.tracker.settleFor(this.ref, status, error);
  }

  /** run.start 时由宿主胶水调用（Cell ↔ Run 绑定 + 生命周期推进）。 */
  attachRun(ref: RunRef): void {
    this.ref = ref;
    if (this.phase === "ready") this.phase = "running";
  }

  /** 就绪凭据到手（wireCell 探到一次应答后调用）；只影响收尾是否等 dispose。 */
  markHostReady(): void {
    this.hostReady = true;
  }

  /**
   * 收尾（B7③ 的确定次序，切片⑤ §3.3）：halting（拒新）→ 等在途收束 → 必要时 kill → reaped。
   * 等待有硬界 `toolKillGraceMs`（既有那个"宽限后强杀"的量，**不新增时限数**）：同步忙等的插件
   * 会连这个计时器都进不了事件循环，那时只剩 OS 级强杀——已登记为 07 稿 §9 第 3 条限制。
   */
  async drainAndReap(): Promise<DrainOutcome> {
    const startedAt = Date.now();
    if (this.phase !== "exited") this.phase = "halting";
    const inFlightAtStart = this.inFlight.size;
    const timedOut = inFlightAtStart > 0 && !(await this.awaitInFlight(this.supervisor.graceMs));
    const settled = inFlightAtStart - this.inFlight.size;
    // R4：在途动作收束后再给插件一次正常收尾机会（模块 dispose → 资源 effect LIFO）。
    // 只对已就绪且未超时的舱走这一步——没就绪/已失控的舱等 dispose 只会再白等一个 grace。
    if (this.hostReady && !timedOut && !this.exitResult) {
      try {
        await this.call("cell.dispose", {}, this.supervisor.graceMs);
      } catch {
        /* 收尾失败不阻断 reaped；进程 kill 是兜底 */
      }
    }
    // 进程已自然退出（exitResult 已立）就不算"本次收尾杀掉了它"——killed 要说的是这件事
    const needsKill = !this.exitResult;
    await this.kill();
    this.phase = "reaped";
    return {
      inFlightAtStart,
      refused: this.drainRefused,
      settled,
      timedOut,
      killed: needsKill,
      waitedMs: Date.now() - startedAt,
    };
  }

  /** 在途集合全部落定 = true；宽限期先到 = false（调用方据此强杀）。 */
  private awaitInFlight(budgetMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return Promise.resolve(true);
    const settledAll = Promise.allSettled([...this.inFlight]).then(() => true);
    const grace = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), budgetMs));
    return Promise.race([settledAll, grace]);
  }

  /** ManagedCell：装配编排的丢弃语义（收尾 + reaped）。 */
  dispose(): Promise<DrainOutcome> {
    return this.drainAndReap();
  }

  /** A5 迁移钩：新 Cell 内、快照挂载后首轮前（失败由 AssemblyManager 回退）。 */
  migrate(oldState: unknown): Promise<unknown> {
    return this.call("cell.migrate", { oldState }, MIGRATE_TIMEOUT_MS);
  }

  /**
   * engine 的一步（Phase 4 切片④，ADR-0023）：Host→Cell 请求/响应，300s 档。
   * 走 `call`：收尾期间拒绝新步（`SCHED/BACKPRESSURE`），在途步计入 drain 等待。
   */
  stepEngine(input: unknown): Promise<unknown> {
    return this.call("engine.step", input, ENGINE_STEP_TIMEOUT_MS);
  }

  /** 快照索取（D3）：宿主于轮边界（onCheckpoint 缝）调用；无快照面 → null。 */
  async pullSnapshot(): Promise<unknown> {
    const r = await this.call<{ state: unknown }>("cell.snapshot", {}, MIGRATE_TIMEOUT_MS);
    return r.state;
  }

  /** 等待进程退出（kill 等待与测试用）。 */
  waitExit(): Promise<CellExit> {
    if (this.exitResult) return Promise.resolve(this.exitResult);
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /**
   * **硬中断**（OS 级 kill，不等在途）：失控看门狗走的同一条路，测试与场景复演也用它表达
   * "在途动作被打断"这个前提（A3/V3：未决效果清单必须由这条路径产生，drain 会把它收成"完成"）。
   * 日常收束请用 `drainAndReap()`——那是 B7③ 定义的确定次序，不是这里。
   */
  async kill(): Promise<void> {
    if (this.exitResult) return;
    this.killRequested = true;
    if (this.phase === "running" || this.phase === "ready") this.phase = "halting";
    this.process.kill();
    await this.waitExit();
  }
}
