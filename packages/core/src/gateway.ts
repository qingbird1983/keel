/**
 * 模型网关 —— 契约 §4.7 + ADR-0003：Cell 内一切 LLM 调用的唯一通道（无凭证、无直连网络）。
 *
 * 时序（契约 §8）：授权 → budget.reserve（预扣估算）→ Core 持凭证代理调用 → settle（权威计量实结）
 * → MODEL_INVOKED / MODEL_USAGE。不变式：无 reservation 不执行；无 settle 不算完成。
 * - 幂等（验收 A7）：同 reqId 已实结的重放直接返回既有结果——不重复计费、不重打上游；
 *   失败调用不缓存，幂等重试安全（重试策略归 hook③，由调用方处置）。
 * - 上游失败：settle(0) 全额退还 → GATEWAY/UPSTREAM-ERROR；网关故障 = 发起 Cell 本轮失败，
 *   不级联其他 Cell（I2）。
 * - shortcut: 不校验重放请求与原请求一致性（调用方不变量：同 reqId 同请求），
 *   Cell 通道信任边界落地（切片③）时补请求摘要校验。
 */

import { KeelError } from "./errors.js";
import { Authorizer } from "./authorizer.js";
import { Budgeter, type Reservation } from "./budget.js";
import { type ModelInvokedPayload, type ModelUsagePayload, type RunRef } from "./events.js";
import { Ledger } from "./ledger.js";

/** 上游适配器（Core 持凭证侧；MVP 可打桩，ADR-0003）。 */
export interface ModelUpstream {
  invoke(req: { model: string; params: unknown }): Promise<{
    result: unknown;
    usage: unknown;
    /** 权威计量（预算器计量单位）；实结以此为准。 */
    cost: number;
  }>;
}

export interface ModelInvokeRequest {
  reqId: string;
  model: string;
  params: unknown;
  /** 发起方估算（预扣）；实结以网关权威计量为准。 */
  estimate: number;
}

export interface ModelInvokeResult {
  result: unknown;
  usage: unknown;
  cost: number;
  /** true = 同 reqId 幂等重放（未重打上游、未重复计费）。 */
  replay: boolean;
}

interface SettledCall {
  result: ModelInvokeResult;
}

export class ModelGateway {
  private readonly ledger: Ledger;
  private readonly auth: Authorizer;
  private readonly budget: Budgeter;
  private readonly upstream: ModelUpstream;
  private readonly settled = new Map<string, SettledCall>();
  /** reqId → 已发起试次数（失败试次 settle(0) 后，重试需新的 reservation 键）。 */
  private readonly attempts = new Map<string, number>();

  constructor(deps: {
    ledger: Ledger;
    auth: Authorizer;
    budget: Budgeter;
    upstream: ModelUpstream;
  }) {
    this.ledger = deps.ledger;
    this.auth = deps.auth;
    this.budget = deps.budget;
    this.upstream = deps.upstream;
  }

  /** model.invoke：授权 → 预扣 → 代理 → 实结（契约 §4.7 / §8 时序）。 */
  async invoke(ref: RunRef, subject: string, req: ModelInvokeRequest): Promise<ModelInvokeResult> {
    const done = this.settled.get(req.reqId);
    if (done) return { ...done.result, replay: true };

    const decision = await this.auth.check(ref, subject, "model.invoke", req.model);
    if (!decision.allowed)
      throw new KeelError("AUTH/DENIED", decision.reason ?? "denied", {
        model: req.model,
      });

    // 首试以 reqId 预扣；失败试次已 settle(0)，重试派生 `reqId#n` 新 reservation（settle 一次语义）
    const attempt = (this.attempts.get(req.reqId) ?? 0) + 1;
    this.attempts.set(req.reqId, attempt);
    const reserveKey = attempt === 1 ? req.reqId : `${req.reqId}#${attempt}`;

    let reservation: Reservation;
    try {
      reservation = await this.budget.reserve(ref, reserveKey, req.estimate);
    } catch (err) {
      // BUDGET/EXHAUSTED 原样上抛（含耗尽处置模式，由调度器处置）；不留 MODEL_INVOKED
      throw err instanceof KeelError ? err : new KeelError("BUDGET/EXHAUSTED", String(err));
    }

    await this.ledger.append(ref, "MODEL_INVOKED", {
      model: req.model,
      reqId: req.reqId,
      requestDigest: req.params,
    } satisfies ModelInvokedPayload);

    let upstream: Awaited<ReturnType<ModelUpstream["invoke"]>>;
    try {
      upstream = await this.upstream.invoke({ model: req.model, params: req.params });
    } catch (err) {
      await this.budget.settle(ref, reservation.reservationId, 0); // 全额退还
      throw new KeelError("GATEWAY/UPSTREAM-ERROR", "model upstream call failed", {
        model: req.model,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    await this.budget.settle(ref, reservation.reservationId, upstream.cost);
    await this.ledger.append(ref, "MODEL_USAGE", {
      reqId: req.reqId,
      usage: upstream.usage,
      cost: upstream.cost,
    } satisfies ModelUsagePayload);

    const result: ModelInvokeResult = {
      result: upstream.result,
      usage: upstream.usage,
      cost: upstream.cost,
      replay: false,
    };
    this.settled.set(req.reqId, { result });
    return result;
  }
}
