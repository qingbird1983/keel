/**
 * 补偿执行器（切片④，ADR-0005 决策 5：补偿执行入口 = Host 层）—— 补偿稿 T01~T14 全路径。
 *
 * - 唯一事实源 = 账本事件流（补偿稿 §3/I3）：project() 重放 EFFECT_* / COMPENSATION_*
 *   重建投影；执行器自身崩溃不丢状态（重入即重放）。
 * - 触发模式三态（契约 §4.1 注记⑥）：verify = T4 只核验未决不回滚；round = T1 以
 *   fromSeq（最近一致点）划界；run = T3/T5 全 Run 回滚。
 * - 候选集（保守，D2）：settled-done（T08）+ verify-pending 无 probe（T06 保守分支）+
 *   declared 未闭环（T02 并入，硬规则「补偿必须容忍目标不存在」兜底）。
 * - 编排（§5.2）：dependsOn 逆拓扑——被依赖者后撤、依赖者先撤（LIFO 为同层 tie-break），
 *   无依赖效果有界并行（默认 4）。
 * - 重试（T10~T12）：≤3 次、退避 ≤30s 钳制（now/delay 注入）；耗尽 → COMPENSATION_ESCALATED
 *   {blockedResume:true} → compensate 返回 false（调度器落 RECOVER/COMPENSATION-FAILED）。
 *   存在 escalated 未豁免时其余效果照常执行（§5.2），但整体仍 false。
 * - record-only（§7）：无需动作进程——直写 COMPENSATION_EXECUTED{recordOnly:true} +
 *   告警缝，闭环以审计持久为准。
 * - 升级出路（§8）：waive（T13 豁免）/ repair（T14 修复后重补偿，attempts 归零，内存
 *   管理通道——跨进程恢复场景登记 backlog）；禁止静默放弃。
 * - 动作通道：一次性新补偿 Cell（ADR-0005「新 Cell」路径），经 factory 注入。
 */

import {
  KeelError,
  type CompensationClass,
  type CompensationScope,
  type EventType,
  type IdempotencyStrategy,
  type Ledger,
  type LedgerEvent,
  type RunRef,
} from "@keel/core";
import type { CompensationExecInput } from "@keel/cell-runtime";

/** 补偿动作 Cell 最小面（生产 = 一次性新 Cell 进程连接；测试注入内存替身）。 */
export interface CompensationActionCell {
  exec(input: CompensationExecInput): Promise<ToolResultLike>;
  dispose(): Promise<void>;
}

export interface ToolResultLike {
  status: "ok" | "error" | "timeout";
  result?: unknown;
  error?: unknown;
  durationMs?: number;
}

export type ActionCellFactory = () => Promise<CompensationActionCell>;

export interface CompensationExecutorOptions {
  now?: () => number;
  /** 重试退避延时注入（standards/05 §3）；默认 setTimeout。 */
  delay?: (ms: number) => Promise<void>;
  /** 无依赖效果并行度（补偿稿 §5.2，默认 4）。 */
  parallel?: number;
  /** 单效果重试上限（T12，默认 3）。 */
  maxAttempts?: number;
  /** 退避上限（默认 30_000，补偿稿 §6）。 */
  backoffCeilingMs?: number;
  /** record-only / 升级告警缝（观测插件接线位；失败吞错不阻断闭环）。 */
  onAlert?: (info: { ref: RunRef; effectId: string; escalated: boolean }) => Promise<void>;
}

/** 投影态（补偿稿 §4.1；投影态 compensable/compensating 不立事件，重放可推导）。 */
export type EffectState =
  | "declared" // 已声明未结算（含执行中——账本不可区分，保守视同未决）
  | "settled-done"
  | "settled-failed" // released 语义：干净失败，不补偿（T04）
  | "verify-pending" // 结果未知，待核验（T05）
  | "compensated"
  | "escalated"
  | "waived";

export interface EffectProjectionEntry {
  effectId: string;
  seq: number; // EFFECT_DECLARED 的 seq（round 模式划界）
  kind: string;
  compensationClass: CompensationClass;
  actionRef: string;
  idempotency: IdempotencyStrategy;
  targetSummary: unknown;
  paramsDigest: unknown;
  probeRef: string | null;
  dependsOn: string[];
  state: EffectState;
  attempts: number;
  lastError?: unknown;
}

/** 会进入补偿集合的投影态（保守候选）。 */
const COMPENSABLE: ReadonlySet<EffectState> = new Set([
  "settled-done",
  "verify-pending",
  "declared",
]);

const PROJECTION_TYPES: EventType[] = [
  "EFFECT_DECLARED",
  "EFFECT_SETTLED",
  "COMPENSATION_EXECUTED",
  "COMPENSATION_ESCALATED",
  "COMPENSATION_WAIVED",
];

export class CompensationExecutor {
  private readonly ledger: Ledger;
  private readonly factory: ActionCellFactory | null;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly parallel: number;
  private readonly maxAttempts: number;
  private readonly backoffCeilingMs: number;
  private readonly onAlert?: CompensationExecutorOptions["onAlert"];
  /** T14 修复通道（内存管理态）：repair 后 escalated 效果在下次 sweep 重获全新尝试预算。 */
  private readonly repaired = new Set<string>();

  constructor(
    deps: { ledger: Ledger; factory?: ActionCellFactory | null },
    opts: CompensationExecutorOptions = {},
  ) {
    this.ledger = deps.ledger;
    this.factory = deps.factory ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.parallel = opts.parallel ?? 4;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffCeilingMs = opts.backoffCeilingMs ?? 30_000;
    this.onAlert = opts.onAlert;
  }

  /** 账本重放 → 投影（唯一事实源；恢复/重入一律先重放）。 */
  async project(ref: RunRef): Promise<Map<string, EffectProjectionEntry>> {
    const map = new Map<string, EffectProjectionEntry>();
    for (const ev of await this.readAll(ref)) {
      const p = ev.payload as Record<string, unknown>;
      switch (ev.type) {
        case "EFFECT_DECLARED": {
          const comp = (p.compensation ?? {}) as Record<string, unknown>;
          map.set(p.effectId as string, {
            effectId: p.effectId as string,
            seq: ev.seq,
            kind: p.kind as string,
            compensationClass: p.compensationClass as CompensationClass,
            actionRef: comp.actionRef as string,
            idempotency: comp.idempotency as IdempotencyStrategy,
            targetSummary: p.targetSummary ?? null,
            paramsDigest: comp.paramsDigest ?? null,
            probeRef: (p.probeRef as string | null) ?? null,
            dependsOn: Array.isArray(p.dependsOn) ? (p.dependsOn as string[]) : [],
            state: "declared",
            attempts: 0,
          });
          break;
        }
        case "EFFECT_SETTLED": {
          const e = map.get(p.effectId as string);
          if (!e) break;
          e.state =
            p.outcome === "done"
              ? "settled-done"
              : p.outcome === "unknown"
                ? "verify-pending"
                : "settled-failed";
          break;
        }
        case "COMPENSATION_EXECUTED": {
          const e = map.get(p.effectId as string);
          if (!e) break;
          e.state = "compensated";
          e.attempts = Math.max(e.attempts, p.attempt as number);
          break;
        }
        case "COMPENSATION_ESCALATED": {
          const e = map.get(p.effectId as string);
          if (!e) break;
          e.state = "escalated";
          e.attempts = p.attempts as number;
          e.lastError = p.lastError;
          break;
        }
        case "COMPENSATION_WAIVED": {
          const e = map.get(p.effectId as string);
          if (!e) break;
          e.state = "waived";
          break;
        }
      }
    }
    return map;
  }

  /**
   * 补偿收尾（调度器三缝经宿主胶水接入）。
   * 返回 false = 存在 escalated 未豁免效果（含本次新升级），调用方落
   * RECOVER/COMPENSATION-FAILED；其余效果仍已尽力闭环（补偿稿 §5.2）。
   */
  async compensate(
    ref: RunRef,
    opts: { mode: CompensationScope; fromSeq?: number },
  ): Promise<boolean> {
    if (opts.mode === "verify") return true; // T4：只核验不回滚；未决留投影由恢复核对
    const projection = await this.project(ref);
    const candidates = [...projection.values()].filter(
      (e) =>
        (COMPENSABLE.has(e.state) ||
          (e.state === "escalated" && this.repaired.has(key(ref, e.effectId)))) &&
        (opts.mode === "run" || e.seq > (opts.fromSeq ?? 0)),
    );
    // T14 修复后重获预算
    for (const e of candidates) if (e.state === "escalated") e.attempts = 0;

    let blocked = [...projection.values()].some(
      (e) => e.state === "escalated" && !candidates.includes(e),
    );
    if (candidates.length === 0) return !blocked;

    const needCell = candidates.some((e) => e.compensationClass !== "record-only");
    const cell = needCell ? await this.requireFactory() : null;
    try {
      // 波 = 依赖全部落在更早波次的候选（静态分层，依赖只指后）；逐波串行保逆拓扑序，
      // 波内有界并行（补偿稿 §5.2 默认 4）
      for (const wave of this.waves(candidates)) {
        for (let i = 0; i < wave.length; i += this.parallel) {
          const results = await Promise.all(
            wave.slice(i, i + this.parallel).map((e) => this.compensateOne(ref, cell, e)),
          );
          if (results.includes("escalated")) blocked = true;
        }
      }
    } finally {
      await cell?.dispose();
    }
    return !blocked;
  }

  /** T13 所有者豁免：仅对 escalated 效果有效（留痕归因）。 */
  async waive(ref: RunRef, effectId: string, waivedBy: string, reason: string): Promise<void> {
    const e = (await this.project(ref)).get(effectId);
    if (!e) {
      throw new KeelError("SCHED/NOT-FOUND", "effect not found in run projection", {
        runId: ref.runId,
        effectId,
      });
    }
    if (e.state !== "escalated") {
      throw new KeelError("RECOVER/COMPENSATION-FAILED", "waive requires escalated effect", {
        runId: ref.runId,
        effectId,
        state: e.state,
      });
    }
    await this.ledger.append(ref, "COMPENSATION_WAIVED", { effectId, waivedBy, reason });
    this.repaired.delete(key(ref, effectId));
  }

  /** T14 所有者修复后重补偿：attempts 归零（内存管理通道），下次 sweep 重派。 */
  async repair(ref: RunRef, effectId: string): Promise<void> {
    const e = (await this.project(ref)).get(effectId);
    if (!e) {
      throw new KeelError("SCHED/NOT-FOUND", "effect not found in run projection", {
        runId: ref.runId,
        effectId,
      });
    }
    if (e.state !== "escalated") {
      throw new KeelError("RECOVER/COMPENSATION-FAILED", "repair requires escalated effect", {
        runId: ref.runId,
        effectId,
        state: e.state,
      });
    }
    this.repaired.add(key(ref, effectId));
  }

  /* ── 内部 ────────────────────────────────────────────────────────── */

  private async compensateOne(
    ref: RunRef,
    cell: CompensationActionCell | null,
    e: EffectProjectionEntry,
  ): Promise<"compensated" | "escalated"> {
    if (e.compensationClass === "record-only") {
      // §7：动作即「强制留痕 + 告警」，闭环以审计持久为准
      await this.ledger.append(ref, "COMPENSATION_EXECUTED", {
        effectId: e.effectId,
        attempt: 1,
        resultDigest: { recordOnly: true },
        durationMs: 0,
      });
      await this.alert(ref, e.effectId, false); // 告警缝内部吞错；await 保证回调先于 sweep 返回
      return "compensated";
    }
    if (!cell) {
      // 候选过滤已保证：非 record-only 必有动作 Cell（needCell → factory）
      throw new KeelError("RECOVER/COMPENSATION-FAILED", "action cell missing", {
        effectId: e.effectId,
      });
    }
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const t0 = this.now();
      const r = await cell.exec({
        actionRef: e.actionRef,
        effectId: e.effectId,
        targetSummary: e.targetSummary ?? undefined,
        paramsDigest: e.paramsDigest ?? undefined,
        phase: "undo",
      });
      if (r.status === "ok") {
        await this.ledger.append(ref, "COMPENSATION_EXECUTED", {
          effectId: e.effectId,
          attempt,
          resultDigest: r.result ?? null,
          durationMs: r.durationMs ?? this.now() - t0,
        });
        return "compensated";
      }
      lastError = r.error ?? { code: "COMPENSATION/UNKNOWN" };
      if (attempt < this.maxAttempts) {
        await this.delay(Math.min(1_000 * 2 ** (attempt - 1), this.backoffCeilingMs));
      }
    }
    await this.ledger.append(ref, "COMPENSATION_ESCALATED", {
      effectId: e.effectId,
      attempts: this.maxAttempts,
      lastError,
      blockedResume: true,
    });
    await this.alert(ref, e.effectId, true);
    return "escalated";
  }

  private async alert(ref: RunRef, effectId: string, escalated: boolean): Promise<void> {
    if (!this.onAlert) return;
    try {
      await this.onAlert({ ref, effectId, escalated });
    } catch {
      /* 告警缝失败不阻断闭环（审计已持久） */
    }
  }

  private async requireFactory(): Promise<CompensationActionCell> {
    if (!this.factory) {
      throw new KeelError("RECOVER/COMPENSATION-FAILED", "no action cell factory configured", {});
    }
    return this.factory();
  }

  /**
   * 逆拓扑分波（补偿稿 §5.2）：依赖者（后声明、依赖他人）先撤销，被依赖者后撤销；
   * 同层 LIFO（seq 降序 tie-break）。就绪 = 依赖「我」的候选均已撤销（Kahn 入度语义）。
   * 每波按并行度切片；成环残余（声明期校验漏网的防御分支）按 LIFO 收尾。
   */
  private waves(candidates: EffectProjectionEntry[]): EffectProjectionEntry[][] {
    const byId = new Map(candidates.map((e) => [e.effectId, e]));
    // dependentsOf[X] = 依赖 X 的候选集合（X 须待它们全部撤销后才轮到）
    const dependentsOf = new Map<string, Set<string>>();
    for (const e of candidates) {
      for (const d of e.dependsOn) {
        if (!byId.has(d)) continue; // 依赖不在候选集（已闭环/已豁免）：无约束
        let s = dependentsOf.get(d);
        if (!s) dependentsOf.set(d, (s = new Set()));
        s.add(e.effectId);
      }
    }
    const remaining = new Set(candidates.map((e) => e.effectId));
    const waves: EffectProjectionEntry[][] = [];
    while (remaining.size > 0) {
      const ready = [...remaining]
        .filter((id) => {
          for (const dep of dependentsOf.get(id) ?? []) if (remaining.has(dep)) return false;
          return true;
        })
        .sort(
          (a, b) =>
            (byId.get(b) as EffectProjectionEntry).seq - (byId.get(a) as EffectProjectionEntry).seq,
        );
      if (ready.length === 0) {
        waves.push(
          [...remaining]
            .map((id) => byId.get(id) as EffectProjectionEntry)
            .sort((a, b) => b.seq - a.seq),
        );
        break;
      }
      waves.push(ready.map((id) => byId.get(id) as EffectProjectionEntry));
      for (const id of ready) remaining.delete(id);
    }
    return waves;
  }

  private async readAll(ref: RunRef): Promise<LedgerEvent[]> {
    const out: LedgerEvent[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.ledger.read({ runId: ref.runId, types: PROJECTION_TYPES }, cursor);
      out.push(...page.events);
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
  }
}

function key(ref: RunRef, effectId: string): string {
  return `${ref.runId}|${effectId}`;
}
