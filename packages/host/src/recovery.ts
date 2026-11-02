/**
 * 恢复管理器（切片④，契约 §4.5 + ADR-0004 §4.4 / ADR-0005 recovering 态）。
 *
 * - plan：最近一致点（Ledger.lastCheckpoint 冷实例可扫）+ 未决副作用清单（投影保守候选）
 *   + 最近快照引用/版本（STATE_SNAPSHOT_REF 元数据）。未知 runId → RECOVER/RUN-UNKNOWN。
 * - execute（顺序硬约束，ADR-0004 §4.4「先核对未决副作用补偿表，再续跑」）：
 *     ① 全 Run 补偿（run 模式；escalated 未豁免 → RECOVER/COMPENSATION-FAILED）
 *     ② 快照挂载：账本有 STATE_SNAPSHOT_REF 而存储缺条目 → RECOVER/SNAPSHOT-MISSING；
 *        挂载复用 cell.migrate 通道（契约 §4.5 切片④注记）
 *     ③ 延续由调用方回调 cont 完成（spawn 新 Cell / serve 通道 / scheduler.start 带
 *        recoveredFrom）——宿主装配细节不进本模块（Cell↔Run 装配归调用方胶水）。
 * - 前置：旧 run 已终态（failed/halted；宿主胶水在 onCellExit → abort 落终态后调用）。
 *   未决效果的补偿在原 runId 作用域内闭环，新 runId 不继承未决效果（契约 §4.5 作用域澄清）。
 */

import { KeelError, type Ledger, type RunRef } from "@keel/core";
import type { CompensationExecutor, EffectProjectionEntry } from "./compensator.js";
import type { SnapshotStore } from "./snapshot.js";

export interface RecoveryPlan {
  oldRunId: string;
  /** 最近一致点（无 CHECKPOINT 时 null——run 早夭，无状态可挂载）。 */
  checkpoint: { seq: number; round: number } | null;
  /** 未决副作用清单（投影保守候选：declared / settled-done / verify-pending）。 */
  pending: Pick<
    EffectProjectionEntry,
    "effectId" | "kind" | "state" | "compensationClass" | "seq"
  >[];
  /** 最近 STATE_SNAPSHOT_REF 元数据（无快照 run 为 null）。 */
  snapshot: { ref: string; version: number; round: number } | null;
}

export interface RecoveredContinuation {
  runId: string;
  done: Promise<{ state: string; reasonCode?: string }>;
}

export class RecoveryManager {
  private readonly ledger: Ledger;
  private readonly compensator: CompensationExecutor;
  private readonly snapshots: SnapshotStore;

  constructor(deps: {
    ledger: Ledger;
    compensator: CompensationExecutor;
    snapshots: SnapshotStore;
  }) {
    this.ledger = deps.ledger;
    this.compensator = deps.compensator;
    this.snapshots = deps.snapshots;
  }

  /** 恢复计划（只读；幂等）。 */
  async plan(oldRef: RunRef): Promise<RecoveryPlan> {
    // run 存在性：账本 scopeOf 查无此 runId = LEDGER/CURSOR-INVALID → 契约 RECOVER/RUN-UNKNOWN
    try {
      await this.ledger.read({ runId: oldRef.runId, seqTo: 1 });
    } catch {
      throw new KeelError("RECOVER/RUN-UNKNOWN", "no ledger scope for runId", {
        runId: oldRef.runId,
      });
    }
    const checkpoint = await this.ledger.lastCheckpoint(oldRef);
    const projection = await this.compensator.project(oldRef);
    const pending = [...projection.values()]
      .filter(
        (e) => e.state === "declared" || e.state === "settled-done" || e.state === "verify-pending",
      )
      .map((e) => ({
        effectId: e.effectId,
        kind: e.kind,
        state: e.state,
        compensationClass: e.compensationClass,
        seq: e.seq,
      }));
    const snapshot = await this.lastSnapshotRef(oldRef);
    return { oldRunId: oldRef.runId, checkpoint, pending, snapshot };
  }

  /**
   * 执行恢复：补偿 → 快照挂载 → 经 cont 以新 runId 延续。同 runId 重复 execute 幂等
   * （补偿投影闭环后重放无害；延续由 cont 的同 runId 语义兜底）。
   */
  async execute(
    oldRef: RunRef,
    cont: (plan: RecoveryPlan, mountState: unknown) => Promise<RecoveredContinuation>,
  ): Promise<{ plan: RecoveryPlan } & RecoveredContinuation> {
    const plan = await this.plan(oldRef);
    // ① 先核对未决补偿表（ADR-0004 §4.4）：全 Run 补偿，升级阻断即恢复失败
    const closed = await this.compensator.compensate(oldRef, { mode: "run" });
    if (!closed) {
      throw new KeelError(
        "RECOVER/COMPENSATION-FAILED",
        "escalated compensation blocks resume (waive or repair first)",
        { runId: oldRef.runId },
      );
    }
    // ② 快照挂载状态（账本有 ref 而存储缺失 → SNAPSHOT-MISSING；无快照 → null）
    let mountState: unknown = null;
    if (plan.snapshot) {
      const entry = this.snapshots.get(plan.snapshot.ref);
      if (!entry) {
        throw new KeelError("RECOVER/SNAPSHOT-MISSING", "snapshot ref recorded but entry missing", {
          runId: oldRef.runId,
          ref: plan.snapshot.ref,
        });
      }
      mountState = entry.state;
    }
    // ③ 延续（宿主胶水：新 Cell + migrate(mountState) + serve + scheduler.start{recoveredFrom}）
    const resumed = await cont(plan, mountState);
    return { plan, ...resumed };
  }

  private async lastSnapshotRef(
    ref: RunRef,
  ): Promise<{ ref: string; version: number; round: number } | null> {
    let last: { ref: string; version: number; round: number } | null = null;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.ledger.read(
        { runId: ref.runId, types: ["STATE_SNAPSHOT_REF"] },
        cursor,
      );
      for (const ev of page.events) {
        const p = ev.payload as { ref: string; version: number; round: number };
        last = p; // seq 升序，最后一个即最近
      }
      if (!page.nextCursor) return last;
      cursor = page.nextCursor;
    }
  }
}
