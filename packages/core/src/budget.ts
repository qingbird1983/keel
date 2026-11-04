/**
 * 预算器 —— 契约 §4.3（D2）：scope 链 agent ⊃ session ⊃ run；MVP 实现 run + session。
 * 不变式：无 reservation 不执行；无 settle 不算完成（契约 §8，ADR-0003）。
 * 幂等：同 reqId 同额重放返回同一 reservation（不重复预扣）；同 reservation 只结算一次。
 * 耗尽语义三档（hard-stop / graceful / policy）由 scope 配置；本模块只裁决并上报，派发处置归调度器。
 */

import { KeelError } from "./errors.js";
import { Ledger } from "./ledger.js";
import { scopeKey, type RunRef, type Scope } from "./events.js";

/** 耗尽处置模式（契约 §4.3）。 */
export type ExhaustionMode = "hard-stop" | "graceful" | "policy";

export interface BudgetLimits {
  /** run / session 级限额（抽象计量单位）；undefined = 不限量。 */
  run?: number;
  session?: number;
  /** 各级耗尽处置；默认 Run=hard-stop、Session=graceful（契约默认）。 */
  onRunExhausted?: ExhaustionMode;
  onSessionExhausted?: ExhaustionMode;
}

export interface BudgetLevelView {
  limit: number | null;
  used: number;
  remaining: number | null;
}

export interface BudgetQuery {
  run: BudgetLevelView;
  session: BudgetLevelView;
  onRunExhausted: ExhaustionMode;
  onSessionExhausted: ExhaustionMode;
}

export interface Reservation {
  reservationId: string;
  reqId: string;
  estimate: number;
}

interface ScopeState {
  limits: Required<Pick<BudgetLimits, "onRunExhausted" | "onSessionExhausted">> & BudgetLimits;
  sessionUsed: number;
}

interface RunState {
  scopeKey: string;
  used: number;
  /** reqId → reservation（reserve 幂等键）；reservationId → reservation（settle 寻址）。 */
  reservations: Map<string, Reservation>;
  byReservationId: Map<string, Reservation>;
  settled: Map<string, number>;
}

const DEFAULTS = { onRunExhausted: "hard-stop", onSessionExhausted: "graceful" } as const;

export class Budgeter {
  private readonly ledger: Ledger;
  private readonly scopes = new Map<string, ScopeState>();
  private readonly runs = new Map<string, RunState>();
  private seq = 0;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /** 设置某 scope 限额（MVP 配置装载；运行时裁决仍由 reserve/settle 独立执行，契约 §4.3 修订注记）。 */
  configure(scope: Scope, limits: BudgetLimits): void {
    for (const v of [limits.run, limits.session]) {
      if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
        throw new KeelError("BUDGET/INVALID-LIMIT", "limit must be a non-negative finite number", {
          scope,
          limits,
        });
      }
    }
    this.scopes.set(scopeKey(scope), {
      limits: { ...DEFAULTS, ...limits },
      sessionUsed: this.scopes.get(scopeKey(scope))?.sessionUsed ?? 0,
    });
  }

  /** 预扣估算：作用域链自 Run 向上逐级检查并预留；耗尽抛 BUDGET/EXHAUSTED（含处置模式）。 */
  async reserve(ref: RunRef, reqId: string, estimate: number): Promise<Reservation> {
    if (!Number.isFinite(estimate) || estimate < 0) {
      throw new KeelError("BUDGET/INVALID-LIMIT", "estimate must be a non-negative finite number", {
        reqId,
        estimate,
      });
    }
    const run = this.runState(ref);
    const existing = run.reservations.get(reqId);
    if (existing) {
      // 同 id 重放：同额幂等返回；不同额 = Core 内部调用方不变量破坏（standards/04 §2）
      if (existing.estimate !== estimate) {
        throw new KeelError("BUDGET/INVALID-LIMIT", "same reqId replayed with different estimate", {
          reqId,
          estimate,
          booked: existing.estimate,
        });
      }
      return existing;
    }
    const scope = this.scopeState(ref);
    if (scope.limits.run !== undefined && run.used + estimate > scope.limits.run) {
      throw this.exhausted(ref, "run", scope.limits.onRunExhausted);
    }
    if (scope.limits.session !== undefined && scope.sessionUsed + estimate > scope.limits.session) {
      throw this.exhausted(ref, "session", scope.limits.onSessionExhausted);
    }
    run.used += estimate;
    scope.sessionUsed += estimate;
    const reservation: Reservation = {
      reservationId: `res-${++this.seq}-${reqId}`,
      reqId,
      estimate,
    };
    run.reservations.set(reqId, reservation);
    run.byReservationId.set(reservation.reservationId, reservation);
    await this.ledger.append(ref, "BUDGET_RESERVED", {
      reservationId: reservation.reservationId,
      reqId,
      estimate,
      runRemaining: remaining(scope.limits.run, run.used),
      sessionRemaining: remaining(scope.limits.session, scope.sessionUsed),
    });
    return reservation;
  }

  /**
   * 实结：按权威计量扣用并逐级退还差额；写 BUDGET_SETTLED。同 reservation 只结算一次。
   *
   * 单次超支（Phase 4 切片③ R5）：`actual` 可以大于预扣，但**预算不得被打成负数**——
   * 超出部分把用量夹到限额、记 `overrun:true`，该 scope 之后按既有耗尽处置拒绝新预扣。
   * 计量本身不被篡改（`actual` 与 `MODEL_USAGE` 如实），夹的是账上余量。
   */
  async settle(
    ref: RunRef,
    reservationId: string,
    actual: number,
  ): Promise<{ refund: number; overrun: boolean }> {
    if (!Number.isFinite(actual) || actual < 0) {
      throw new KeelError("BUDGET/INVALID-LIMIT", "actual must be a non-negative finite number", {
        reservationId,
      });
    }
    const run = this.runs.get(ref.runId);
    const reservation = run?.byReservationId.get(reservationId);
    if (!run || !reservation) {
      throw new KeelError("BUDGET/RESERVATION-UNKNOWN", "unknown reservation", { reservationId });
    }
    const booked = run.settled.get(reservation.reqId);
    if (booked !== undefined) return { refund: reservation.estimate - booked, overrun: false }; // 幂等重放
    const scope = this.scopeState(ref);
    const delta = actual - reservation.estimate;
    let overrun = false;
    run.used = tidy(run.used + delta);
    if (scope.limits.run !== undefined && run.used > scope.limits.run) {
      run.used = scope.limits.run; // 夹到限额：余量 0，不出现负数
      overrun = true;
    }
    scope.sessionUsed = tidy(scope.sessionUsed + delta);
    if (scope.limits.session !== undefined && scope.sessionUsed > scope.limits.session) {
      scope.sessionUsed = scope.limits.session;
      overrun = true;
    }
    run.settled.set(reservation.reqId, actual);
    const refund = reservation.estimate - actual;
    await this.ledger.append(ref, "BUDGET_SETTLED", {
      reservationId,
      actual,
      refund,
      runRemaining: remaining(scope.limits.run, run.used),
      sessionRemaining: remaining(scope.limits.session, scope.sessionUsed),
      ...(overrun ? { overrun: true as const } : {}),
    });
    return { refund, overrun };
  }

  /** 查询剩余额度与已耗用量（Cell 只读本 run）。 */
  query(ref: RunRef): BudgetQuery {
    const scope = this.scopeState(ref);
    const run = this.runState(ref);
    return {
      run: {
        limit: scope.limits.run ?? null,
        used: run.used,
        remaining: remaining(scope.limits.run, run.used),
      },
      session: {
        limit: scope.limits.session ?? null,
        used: scope.sessionUsed,
        remaining: remaining(scope.limits.session, scope.sessionUsed),
      },
      onRunExhausted: scope.limits.onRunExhausted,
      onSessionExhausted: scope.limits.onSessionExhausted,
    };
  }

  /* ── 内部 ─────────────────────────────────────────────────────────── */

  private scopeState(ref: Scope): ScopeState {
    let s = this.scopes.get(scopeKey(ref));
    if (!s) {
      s = { limits: { ...DEFAULTS }, sessionUsed: 0 };
      this.scopes.set(scopeKey(ref), s);
    }
    return s;
  }

  private runState(ref: RunRef): RunState {
    let r = this.runs.get(ref.runId);
    if (!r) {
      r = {
        scopeKey: scopeKey(ref),
        used: 0,
        reservations: new Map(),
        byReservationId: new Map(),
        settled: new Map(),
      };
      this.runs.set(ref.runId, r);
    }
    return r;
  }

  private exhausted(ref: RunRef, level: "run" | "session", mode: ExhaustionMode): KeelError {
    return new KeelError("BUDGET/EXHAUSTED", `${level} budget exhausted`, {
      runId: ref.runId,
      level,
      mode,
    });
  }
}

function remaining(limit: number | undefined, used: number): number | null {
  return limit === undefined ? null : limit - used;
}

/** 计量是金额/抽象单位：收掉浮点求和噪声（0.7 不该长成 0.7000000000000002）。 */
function tidy(n: number): number {
  return Math.round(n * 1e12) / 1e12;
}
