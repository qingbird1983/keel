/**
 * Cell Supervisor —— Host Layer（架构总览 §4.2）+ ADR-0005：
 * - 生命周期：creating → ready → running → halting → exited → reaped
 * - 退出三分类：clean（exit 0）/ crash（非零退出或致命信号）/ killed（Supervisor 强杀）；
 *   经 onCellExit 通知宿主 → scheduler.abort 落 RUN_FAILED（契约 §4.1 注记④）。
 * - toolCallTimeoutMs 硬强制的后盾（C-D3）：工具调用超时 + 宽限仍无响应 → kill（killed）。
 * - executor 通道绑定：通道死 → error-result 回落（终态统一由 abort 缝落，保证原因码确定）；
 *   切片④：返回前经效果追踪器结算 EFFECT_SETTLED（落点序 EFFECT_SETTLED → TOOL_RESULT）。
 * - 快照（D3，切片④）：pullSnapshot 于轮边界索取（onCheckpoint 缝）；无快照面 = 无状态。
 */

import { type RunRef, type ToolExecutor } from "@keel/core";
import {
  ChannelError,
  FrameConn,
  TRANSPORT_TIMEOUT,
  type ToolExecResult,
} from "@keel/cell-runtime";
import type { CellProcess, IsolationProvider } from "./isolation.js";
import type { LoadedManifest } from "./assembler.js";
import type { ManagedCell } from "./assembly-manager.js";
import type { EffectTracker } from "./effects.js";

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

export interface SupervisorOptions {
  provider: IsolationProvider;
  /** Cell 进程入口（@keel/cell-runtime dist main.js 绝对路径）。 */
  cellEntryPath: string;
  /** 失控强杀宽限：toolCallTimeoutMs 后仍未响应 → 再等此时长 → kill（默认 5s）。 */
  toolKillGraceMs?: number;
  onCellExit?: (exit: CellExit) => void;
}

/** 默认迁移钩超时：A5 序列在 run.start 5s 窗口内（契约 §7）。 */
const MIGRATE_TIMEOUT_MS = 5_000;

export class CellSupervisor {
  private readonly provider: IsolationProvider;
  private readonly cellEntryPath: string;
  private readonly toolKillGraceMs: number;
  private readonly onCellExit?: (exit: CellExit) => void;

  constructor(opts: SupervisorOptions) {
    this.provider = opts.provider;
    this.cellEntryPath = opts.cellEntryPath;
    this.toolKillGraceMs = opts.toolKillGraceMs ?? 5_000;
    this.onCellExit = opts.onCellExit;
  }

  /** spawn Cell 进程并绑定帧通道；Cell ↔ Run 一一对应（run 建立时 attachRun）。 */
  spawnCell(spec: {
    manifest: LoadedManifest;
    pluginPath: string;
    tracker?: EffectTracker;
  }): SupervisedCell {
    return new SupervisedCell({
      supervisor: this,
      manifest: spec.manifest,
      pluginPath: spec.pluginPath,
      tracker: spec.tracker,
    });
  }

  /* internal */
  spawnProcess(bootstrap: string): CellProcess {
    return this.provider.spawn({ entryPath: this.cellEntryPath, bootstrap });
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

  private readonly supervisor: CellSupervisor;
  private readonly process: CellProcess;
  private readonly tracker: EffectTracker | null;
  private killRequested = false;
  private exitResult: CellExit | null = null;
  private notified = false;
  private readonly exitWaiters: Array<(e: CellExit) => void> = [];

  constructor(params: {
    supervisor: CellSupervisor;
    manifest: LoadedManifest;
    pluginPath: string;
    tracker?: EffectTracker;
  }) {
    this.supervisor = params.supervisor;
    this.manifest = params.manifest;
    this.tracker = params.tracker ?? null;
    const boot = JSON.stringify({
      pluginPath: params.pluginPath,
      toolCallTimeoutMs: params.manifest.resources.toolCallTimeoutMs ?? 0,
    });
    this.process = this.supervisor.spawnProcess(boot);
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

  /** 工具执行通道（调度器 RunManifest.executor 绑定）。 */
  readonly executor: ToolExecutor = async (call) => {
    if (this.exitResult) {
      return {
        status: "error",
        error: { code: "TRANSPORT/BADFRAME", message: "cell already exited" },
      };
    }
    // 失控强杀计时（C-D3 + ADR-0005 killed）：超时 + 宽限仍无响应 → kill
    const killTimer = setTimeout(
      () => void this.kill(),
      (this.manifest.resources.toolCallTimeoutMs ?? 0) + this.supervisor.graceMs,
    );
    try {
      // 请求超时 ≥ 强杀计时：正常路径 cell 侧先回 timeout 结果；强杀路径由通道关闭收尾
      const r = await this.conn.request<ToolExecResult>(
        "tool.exec",
        call,
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

  /** run 收束后由宿主调用（halting → reaped）。 */
  async drainAndReap(): Promise<void> {
    if (this.phase !== "exited") this.phase = "halting";
    await this.kill();
    this.phase = "reaped";
  }

  /** ManagedCell：装配编排的丢弃语义（kill + reaped）。 */
  dispose(): Promise<void> {
    return this.drainAndReap();
  }

  /** A5 迁移钩：新 Cell 内、快照挂载后首轮前（失败由 AssemblyManager 回退）。 */
  migrate(oldState: unknown): Promise<unknown> {
    return this.conn.request("cell.migrate", { oldState }, MIGRATE_TIMEOUT_MS);
  }

  /** 快照索取（D3，切片④）：宿主于轮边界（onCheckpoint 缝）调用；无快照面 → null。 */
  async pullSnapshot(): Promise<unknown> {
    const r = await this.conn.request<{ state: unknown }>("cell.snapshot", {}, MIGRATE_TIMEOUT_MS);
    return r.state;
  }

  /** 等待进程退出（kill 等待与测试用）。 */
  waitExit(): Promise<CellExit> {
    if (this.exitResult) return Promise.resolve(this.exitResult);
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  private async kill(): Promise<void> {
    if (this.exitResult) return;
    this.killRequested = true;
    if (this.phase === "running" || this.phase === "ready") this.phase = "halting";
    this.process.kill();
    await this.waitExit();
  }
}
