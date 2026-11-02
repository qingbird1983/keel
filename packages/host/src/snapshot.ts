/**
 * 快照存储（D3，切片④ MVP）：宿主内存持有快照内容，账本仅 STATE_SNAPSHOT_REF 元数据
 * （契约 §4.5 切片④注记；A3 主张只需 Cell 进程死亡可恢复，宿主进程存活）。
 *
 * - ref 约定：`<agentId>|<sessionId>/snap-<version>`（scope 内版本单调）。
 * - 物理持久化（宿主崩溃后可恢复）登记 backlog；当前实例丢失 = 恢复走无快照路径
 *   （recover.plan 报 snapshot null / execute 报 RECOVER/SNAPSHOT-MISSING，视 ref 是否在账本）。
 */

import { scopeKey, type Scope } from "@keel/core";

export interface SnapshotEntry {
  state: unknown;
  version: number;
  round: number;
}

export class SnapshotStore {
  /** scopeKey → 最新版本（写入递增）。 */
  private readonly heads = new Map<string, number>();
  /** 完整 ref → 条目。 */
  private readonly entries = new Map<string, SnapshotEntry>();

  /**
   * 保存快照并返回 STATE_SNAPSHOT_REF 元数据；state === null（无状态 Cell）不写、返回 null。
   */
  save(scope: Scope, round: number, state: unknown): { ref: string; version: number } | null {
    if (state === null || state === undefined) return null;
    const key = scopeKey(scope);
    const version = (this.heads.get(key) ?? 0) + 1;
    this.heads.set(key, version);
    const ref = `${key}/snap-${version}`;
    this.entries.set(ref, { state, version, round });
    return { ref, version };
  }

  /** 按 ref 取快照；未知 ref（含实例重启丢失）返回 undefined。 */
  get(ref: string): SnapshotEntry | undefined {
    return this.entries.get(ref);
  }
}
