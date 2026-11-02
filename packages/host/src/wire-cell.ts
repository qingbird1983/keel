/**
 * 装配收敛点（Phase 2 切片②，03 稿 §5；[ADR-0011](../../../docs/adr/ADR-0011-cell-load-gate.md)）——
 * `起舱 → 绑通道 → 建分区 → 探就绪` 四步一次做完，返回可直接起 run 的 Cell。
 *
 * 为什么要有这个函数（开工事实 F2/F3）：这四步此前散落在 `wireRun`、`cmd-hotswap` 与两处测试 rig 里，
 * 各自抄一遍且**都不探就绪**——于是"装配完成"与"插件装载完成"之间没有凭据，
 * 换绑之后的新舱能不能用也从没被跑到过。装配、热升级、起会话三条路现在共用同一个事实。
 *
 * 就绪凭据 = 一次既有 Host→Cell 查询（`cell.snapshot`）得到应答：**单次、不重试**。
 * 等不到（超时或通道断）即 `dispose` 该舱（退出分类 killed）并抛错——
 * 错误码沿用契约 §6 的封闭集合：探测未得到应答就是 `TRANSPORT/TIMEOUT`（结果未知，
 * 调用方不得假设插件装载成功或失败，只能拒绝装配），**不新增错误码**。
 */

import { KeelError, type RunRef, type Scope } from "@keel/core";
import { CellSupervisor, SupervisedCell } from "./supervisor.js";
import { EffectTracker } from "./effects.js";
import { serveCellChannel, type CellServerDeps } from "./cell-server.js";
import type { LoadedManifest } from "./assembler.js";

/** 契约 §7（切片②追加行）：就绪探测默认超时，与 `run.start` 的冷启动口径同源。 */
export const CELL_READY_TIMEOUT_MS = 5_000;

export interface WireCellParams {
  supervisor: CellSupervisor;
  /** 通道服务的内核依赖（ledger/auth/budget/ctx/gateway；tracker 缺省由本函数构造）。 */
  deps: CellServerDeps;
  scope: Scope;
  /** Cell↔Run 一一对应（契约 §3.2）：装配时就要给出这个舱归属哪个 run。 */
  ref: RunRef;
  subject: string;
  manifest: LoadedManifest;
  pluginPath: string;
  /** 承接层入口（缺省 = supervisor 的新生态入口；ADR-0010 决策 8）。 */
  cellEntry?: string;
  tracker?: EffectTracker;
  readyTimeoutMs?: number;
}

export interface WiredCell {
  cell: SupervisedCell;
  tracker: EffectTracker;
}

export async function wireCell(p: WireCellParams): Promise<WiredCell> {
  const tracker = p.tracker ?? new EffectTracker({ ledger: p.deps.ledger });
  const cell = p.supervisor.spawnCell({
    manifest: p.manifest,
    pluginPath: p.pluginPath,
    cellEntry: p.cellEntry,
    tracker,
  });
  // 接线次序固定（P-002 规则 1/2）：serve 先于 alloc，两者都先于任何可能进入通道的请求
  serveCellChannel(
    cell.conn,
    {
      scope: p.scope,
      ref: p.ref,
      subject: p.subject,
      templates: new Map(p.manifest.templates.map((t) => [t.kind, t])),
    },
    { ...p.deps, tracker },
  );
  p.deps.ctx.alloc(p.scope);
  try {
    await cell.conn.request("cell.snapshot", {}, p.readyTimeoutMs ?? CELL_READY_TIMEOUT_MS);
  } catch (err) {
    await cell.drainAndReap();
    // 错误码沿用封闭集合：通道已断就说通道断了，其余（含门未开导致的超时）按"未得到应答"报 TIMEOUT
    const code =
      (err as { code?: unknown })?.code === "TRANSPORT/BADFRAME"
        ? "TRANSPORT/BADFRAME"
        : "TRANSPORT/TIMEOUT";
    throw new KeelError(code, "cell not ready: no reply to the readiness probe", {
      reason: "CELL_NOT_READY",
      scope: p.scope,
      runId: p.ref.runId,
      pluginPath: p.pluginPath,
      disposed: true,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  return { cell, tracker };
}
