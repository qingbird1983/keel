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
import {
  priceUsage,
  readUsageBuckets,
  type PricingTierName,
  type UsageBuckets,
} from "./pricing.js";
import {
  STREAM_DEADLINE_MS,
  STREAM_DEFAULT_LIMIT,
  STREAM_MAX_BUFFERED,
  STREAM_WAIT_MS,
  StreamRegistry,
  type StreamPart,
  type StreamSession,
} from "./stream.js";
import {
  MODEL_INVOKE_TIMEOUT_MS,
  type ModelInvokeRequest,
  type ModelInvokeResult,
  type ModelRegistration,
  type ModelUpstream,
  type NextStep,
  type SettledCall,
  type StreamPage,
  type UpstreamOutcome,
} from "./gateway-types.js";

export type {
  ModelInvokeRequest,
  ModelInvokeResult,
  ModelRegistration,
  ModelUpstream,
  StreamPage,
} from "./gateway-types.js";
export { MODEL_INVOKE_TIMEOUT_MS } from "./gateway-types.js";

export class ModelGateway {
  private readonly ledger: Ledger;
  private readonly auth: Authorizer;
  private readonly budget: Budgeter;
  private readonly upstream: ModelUpstream;
  private readonly settled = new Map<string, SettledCall>();
  /** reqId → 已发起试次数（失败试次 settle(0) 后，重试需新的 reservation 键）。 */
  private readonly attempts = new Map<string, number>();
  /** 流式会话表与已终结页（ADR-0013 决策 1/5）。 */
  private readonly streams = new StreamRegistry();
  private readonly settledStreams = new Map<string, StreamPage>();
  /**
   * 单次取片等待上限与会话总长：默认 = 契约 §7 的"流式首字节 30s / 流式总长 300s"。
   * 这两个注入位是**测试缝**（standards/05 §3），不是可配的运行期参数——默认值就是契约数字。
   */
  private readonly streamWaitMs: number;
  private readonly streamDeadlineMs: number;
  private readonly invokeTimeoutMs: number;
  private readonly now: () => number;
  /** 模型名 → 已注册上游 + 价格表（profile 装配期写入；空 = 旧的单上游路径）。 */
  private readonly models = new Map<string, ModelRegistration>();

  constructor(deps: {
    ledger: Ledger;
    auth: Authorizer;
    budget: Budgeter;
    upstream: ModelUpstream;
    streamWaitMs?: number;
    streamDeadlineMs?: number;
    invokeTimeoutMs?: number;
    now?: () => number;
  }) {
    this.ledger = deps.ledger;
    this.auth = deps.auth;
    this.budget = deps.budget;
    this.upstream = deps.upstream;
    this.streamWaitMs = deps.streamWaitMs ?? STREAM_WAIT_MS;
    this.streamDeadlineMs = deps.streamDeadlineMs ?? STREAM_DEADLINE_MS;
    this.invokeTimeoutMs = deps.invokeTimeoutMs ?? MODEL_INVOKE_TIMEOUT_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * 注册 `kind:"model"` 插件的上游与价格表（Phase 4 切片③）：一旦有任何注册，
   * **未注册的模型名一律拒绝**（不回落到宿主演示桩——桩会让"没接上的模型"看起来能用）。
   * 同名重复注册 = 装配错误（一个模型名只能有一个权威上游）。
   */
  registerModel(registration: ModelRegistration, opts?: { replace?: boolean }): void {
    for (const model of registration.models) {
      if (this.models.has(model) && opts?.replace !== true) {
        throw new KeelError("SCHED/MANIFEST-INVALID", "model is registered twice", { model });
      }
    }
    for (const model of registration.models) this.models.set(model, registration);
  }

  /** 已注册模型名（诊断/测试用）。 */
  get registeredModels(): string[] {
    return [...this.models.keys()];
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

    // profile 已注册模型时，未注册的名字不落预扣、不打上游（fail closed）
    const route = this.resolveModel(req.model);

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

    // 总时限（契约 §7 120s）：到点 = 上游失败，全额退还并闭环（不留下悬空预扣）
    const outcome = await this.callUpstream(route?.upstream ?? this.upstream, {
      model: req.model,
      params: req.params,
    });
    if (outcome.kind === "timeout") {
      await this.budget.settle(ref, reservation.reservationId, 0);
      throw new KeelError("GATEWAY/UPSTREAM-ERROR", "model upstream call timed out", {
        model: req.model,
        reason: "INVOKE_TIMEOUT",
        timeoutMs: this.invokeTimeoutMs,
      });
    }
    if (outcome.kind === "error") {
      await this.budget.settle(ref, reservation.reservationId, 0); // 全额退还
      // 模块可带稳定 reason（RATE_LIMITED / TOOL_CHOICE_UNSUPPORTED / …）：如实透出便于归因，
      // 但只接受字符串——不把模块的任意对象当诊断数据写进账本。
      const reported = (outcome.error as { reason?: unknown } | null)?.reason;
      throw new KeelError("GATEWAY/UPSTREAM-ERROR", "model upstream call failed", {
        model: req.model,
        ...(typeof reported === "string" ? { reason: reported } : {}),
        cause: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      });
    }
    const upstream = outcome.value;

    let cost = upstream.cost;
    let usageBuckets: UsageBuckets | undefined;
    let tier: PricingTierName | undefined;
    if (route) {
      // 费用权威在 Core（M3）：模块自报 cost = 协议违规，显式拒绝、不静默忽略
      if (Object.prototype.hasOwnProperty.call(upstream, "cost")) {
        await this.budget.settle(ref, reservation.reservationId, 0);
        throw new KeelError("GATEWAY/UPSTREAM-ERROR", "model module must not report cost", {
          model: req.model,
          reason: "UPSTREAM_PROVIDED_COST",
        });
      }
      try {
        usageBuckets = readUsageBuckets(upstream.usage);
      } catch (err) {
        await this.budget.settle(ref, reservation.reservationId, 0);
        throw err;
      }
      const priced = priceUsage(route.pricing, usageBuckets, new Date(this.now()));
      cost = priced.cost;
      tier = priced.tier;
    } else if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      // 旧路径的权威计量缺失 = 计量不可信：先闭环再报错（不按 0 记账）
      await this.budget.settle(ref, reservation.reservationId, 0);
      throw new KeelError("GATEWAY/UPSTREAM-ERROR", "model upstream reported no valid meter", {
        model: req.model,
        reason: "UPSTREAM_COST_INVALID",
      });
    }

    await this.budget.settle(ref, reservation.reservationId, cost);
    await this.ledger.append(ref, "MODEL_USAGE", {
      reqId: req.reqId,
      usage: upstream.usage,
      cost,
      ...(usageBuckets ? { usageBuckets } : {}),
      ...(tier ? { tier } : {}),
      ...(route ? { pricedBy: "manifest" as const } : {}),
    } satisfies ModelUsagePayload);

    const result: ModelInvokeResult = {
      result: upstream.result,
      usage: upstream.usage,
      cost,
      replay: false,
    };
    this.settled.set(req.reqId, { result });
    return result;
  }

  /**
   * `model.stream.start`（契约 §4.7 + ADR-0013）：授权一次 → 预扣一次 → 一条 `MODEL_INVOKED`
   * （追加 `streamId`）→ 打开上游并取**首页**。每片不写事件（否则账本体积 = 流长度的函数）。
   * 幂等：同 reqId 命中未终会话 = 返回同一 `streamId`（不重打上游、`budget.reserve` 自身幂等）；
   * 命中已终会话 = 返回既有终页并标 `replay:true`。
   */
  async streamStart(ref: RunRef, subject: string, req: ModelInvokeRequest): Promise<StreamPage> {
    const live = this.streams.byReq(req.reqId);
    if (live && !live.finalized) {
      return {
        streamId: live.streamId,
        chunks: [],
        done: false,
        produced: live.produced,
        cost: live.cost,
        replay: true,
      };
    }
    if (live?.finalized) {
      const page = this.settledStreams.get(live.streamId);
      if (page) return { ...page, replay: true };
    }

    const decision = await this.auth.check(ref, subject, "model.stream", req.model);
    if (!decision.allowed)
      throw new KeelError("AUTH/DENIED", decision.reason ?? "denied", { model: req.model });

    const route = this.resolveModel(req.model);

    const reservation = await this.budget.reserve(ref, req.reqId, req.estimate);
    const streamId = this.streams.newStreamId(req.reqId);
    await this.ledger.append(ref, "MODEL_INVOKED", {
      model: req.model,
      reqId: req.reqId,
      requestDigest: req.params,
      streamId,
    } satisfies ModelInvokedPayload);

    const source = (route?.upstream ?? this.upstream).stream?.({
      model: req.model,
      params: req.params,
    });
    if (!source) {
      await this.budget.settle(ref, reservation.reservationId, 0); // 一片都没出：全额退还并闭环
      throw new KeelError("GATEWAY/UPSTREAM-ERROR", "model upstream has no streaming support", {
        model: req.model,
        reason: "UPSTREAM_NO_STREAM",
      });
    }
    const session: StreamSession = {
      streamId,
      reqId: req.reqId,
      ref,
      subject,
      model: req.model,
      reservationId: reservation.reservationId,
      iterator: source[Symbol.asyncIterator](),
      startedAt: this.now(),
      cost: 0,
      usage: undefined,
      produced: 0,
      finalized: false,
      truncated: false,
      ...(route ? { pricing: route.pricing } : {}),
    };
    this.streams.add(session);
    return await this.pump(ref, session, STREAM_DEFAULT_LIMIT);
  }

  /**
   * `model.stream.next`：取至多 `limit` 片。**授权不重复**（决策 3：一次调用一次授权，
   * 权威计量在终局 settle）；受理条件 = 会话存在且属于**本 run 本主体**（`streamId` 是标识符
   * 不是权限，猜到一个 id 也取不到别人的片；不区分"没有"与"不是你的"，免得留下跨 run 探测信道）。
   */
  async streamNext(
    ref: RunRef,
    subject: string,
    streamId: string,
    limit?: number,
  ): Promise<StreamPage> {
    const session = this.streams.owned(streamId, ref, subject);
    if (!session) {
      throw new KeelError("SCHED/NOT-FOUND", "no stream session for this run/subject", {
        streamId,
        reason: "STREAM_NOT_FOUND",
      });
    }
    if (session.finalized) {
      const page = this.settledStreams.get(streamId);
      return page
        ? { ...page, replay: true }
        : { streamId, chunks: [], done: true, produced: session.produced, replay: true };
    }
    return await this.pump(ref, session, limit ?? STREAM_DEFAULT_LIMIT);
  }

  /** `model.stream.cancel`：调用方主动收摊 = 断流口径（已产出部分结算，`truncated:true`）。 */
  async streamCancel(
    ref: RunRef,
    subject: string,
    streamId: string,
  ): Promise<{ settled: true; cost: number; truncated: boolean }> {
    const session = this.streams.owned(streamId, ref, subject);
    if (!session) {
      throw new KeelError("SCHED/NOT-FOUND", "no stream session for this run/subject", {
        streamId,
        reason: "STREAM_NOT_FOUND",
      });
    }
    const page = session.finalized
      ? (this.settledStreams.get(streamId) ?? {
          streamId,
          chunks: [],
          done: true,
          produced: session.produced,
          cost: session.cost,
          truncated: session.truncated,
        })
      : await this.finalize(ref, session, true);
    return { settled: true, cost: page.cost ?? 0, truncated: session.truncated };
  }

  /** 已注册任何 model 插件后，未注册的模型名一律拒绝（不回落到宿主演示桩）。 */
  private resolveModel(model: string): ModelRegistration | undefined {
    if (this.models.size === 0) return undefined;
    const route = this.models.get(model);
    if (!route) {
      throw new KeelError("GATEWAY/UPSTREAM-ERROR", "model is not registered in this profile", {
        model,
        reason: "MODEL_NOT_REGISTERED",
      });
    }
    return route;
  }

  /**
   * 带总时限的上游调用（契约 §7 非流式 120s）。超时与上游抛都收成**值**——
   * "先 settle(0) 闭环、再报错"的次序不能被异常绕过。
   */
  private async callUpstream(
    upstream: ModelUpstream,
    req: { model: string; params: unknown },
  ): Promise<UpstreamOutcome> {
    const call = upstream.invoke(req);
    // race 迟到的拒绝不该变成进程级未处理拒绝
    void call.catch(() => undefined);
    return await Promise.race([
      call.then(
        (value): UpstreamOutcome => ({ kind: "ok", value }),
        (error: unknown): UpstreamOutcome => ({ kind: "error", error }),
      ),
      new Promise<UpstreamOutcome>((resolve) => {
        const t = setTimeout(() => resolve({ kind: "timeout" }), Math.max(this.invokeTimeoutMs, 1));
        t.unref?.();
      }),
    ]);
  }

  /** 取一片的四种结局：出片 / 上游结束 / 等待超时（= 断流）/ 上游抛（= 上游失败）。 */
  private async nextPart(session: StreamSession, budgetMs: number): Promise<NextStep> {
    const next = session.iterator.next();
    // 弃用的那次 next() 结果永不进会话（决策 4："结果未知"就不假装知道）；挂个 catch 免浮空拒绝
    void next.catch(() => undefined);
    return await Promise.race([
      next.then(
        (v): NextStep =>
          v.done === true ? { kind: "end" } : { kind: "part", part: v.value as StreamPart },
        // 上游抛 = 收成一个**值**交回本方法，而不是让异常绕过 settle 冒出去
        (error: unknown): NextStep => ({ kind: "failed", error }),
      ),
      new Promise<NextStep>((resolve) => {
        const t = setTimeout(() => resolve({ kind: "stalled" }), Math.max(budgetMs, 1));
        t.unref?.(); // 计时器不该把进程留在身后（测试与 CLI 收束都靠自然退出）
      }),
    ]);
  }

  /**
   * 取一页：按顺序向上游要片，最多 `limit` 片。四种终局都从这里出——
   * 上游自然结束（`truncated:false`）、会话总长到点、单次等待超时（后两者 `truncated:true`）、
   * 上游抛（先按断流口径闭环，再以 `GATEWAY/UPSTREAM-ERROR` 报错）。
   * 一片都没出的断流 = 失败（抛 `GATEWAY/UPSTREAM-ERROR`），但仍先 settle 闭环（不留悬空预扣）。
   */
  private async pump(ref: RunRef, session: StreamSession, limit: number): Promise<StreamPage> {
    const max = Math.min(Math.max(Math.trunc(limit) || 1, 1), STREAM_MAX_BUFFERED);
    const chunks: unknown[] = [];
    for (;;) {
      const remainingMs = session.startedAt + this.streamDeadlineMs - this.now();
      if (remainingMs <= 0) return await this.closeOrThrow(ref, session, chunks, "DEADLINE");
      const step = await this.nextPart(session, Math.min(this.streamWaitMs, remainingMs));
      if (step.kind === "stalled") return await this.closeOrThrow(ref, session, chunks, "STALL");
      if (step.kind === "failed") {
        // 上游抛（不是慢）：**先闭环再报错**——已产出部分照常 settle + `truncated:true` 的用量，
        // 但绝不把"半截答案"包装成一次正常结束的页（`done:true` 会被读成"上游说完了"）。
        throw await this.closeOnUpstreamFailure(ref, session, step.error);
      }
      if (step.kind === "end") {
        // 上游结束 = 终局，但**本页已取到的片不能丢**：终页也要把这一批内容交回去
        const page = await this.finalize(ref, session, false);
        return { ...page, chunks };
      }
      const part = step.part;
      // 费用权威在 Core（M3）：manifest 计价路径里模块带 cost = 协议违规，先闭环再报错
      if (session.pricing && Object.prototype.hasOwnProperty.call(part, "cost")) {
        throw await this.closeOnProtocolError(ref, session, "UPSTREAM_PROVIDED_COST");
      }
      chunks.push(part.chunk);
      session.produced += 1;
      if (!session.pricing) session.cost += part.cost ?? 0;
      if (part.usage !== undefined) session.usage = part.usage;
      if (chunks.length >= max) break;
    }
    return {
      streamId: session.streamId,
      chunks,
      done: false,
      produced: session.produced,
      // manifest 计价 = 终局按三桶总价结算，中间页不给"半截金额"
      ...(session.pricing ? {} : { cost: session.cost }),
      usage: session.usage,
    };
  }

  /** 模块协议违规（如自报 cost）：按断流口径闭环已产出部分，再抛给调用方。 */
  private async closeOnProtocolError(
    ref: RunRef,
    session: StreamSession,
    reason: string,
  ): Promise<KeelError> {
    await this.finalize(ref, session, true);
    return new KeelError("GATEWAY/UPSTREAM-ERROR", "model upstream violated the stream protocol", {
      model: session.model,
      reqId: session.reqId,
      streamId: session.streamId,
      reason,
      produced: session.produced,
    });
  }

  /** 断流收束：先 settle + `MODEL_USAGE{truncated:true}`，再决定"有产物就还给调用方、没产物就报失败"。 */
  private async closeOrThrow(
    ref: RunRef,
    session: StreamSession,
    chunksSoFar: unknown[],
    reason: "DEADLINE" | "STALL",
  ): Promise<StreamPage> {
    const producedAnything = chunksSoFar.length > 0 || session.produced > 0;
    const page = await this.finalize(ref, session, true);
    if (producedAnything) return { ...page, chunks: chunksSoFar };
    throw new KeelError(
      "GATEWAY/UPSTREAM-ERROR",
      reason === "DEADLINE"
        ? "model stream produced nothing before the total-length deadline"
        : "model stream produced nothing before the first-chunk wait limit",
      {
        model: session.model,
        reqId: session.reqId,
        reason: `STREAM_${reason}`,
        streamId: session.streamId,
      },
    );
  }

  /**
   * 上游中途抛：走**断流的闭环口径**（settle 已产出部分 + `MODEL_USAGE{truncated:true}`），
   * 然后把错误交给发起方（返回一个已构造好的 `KeelError`，由调用点 `throw`——"先记账、后报错"
   * 的次序在代码里可见）。为什么不像慢断流那样把半截内容还给调用方：上游明确失败了，
   * 把"半截答案"标成 `done:true` 就是把它读成完整回答（禁止静默降级）。
   */
  private async closeOnUpstreamFailure(
    ref: RunRef,
    session: StreamSession,
    cause: unknown,
  ): Promise<KeelError> {
    await this.finalize(ref, session, true);
    return new KeelError("GATEWAY/UPSTREAM-ERROR", "model stream upstream failed", {
      model: session.model,
      reqId: session.reqId,
      streamId: session.streamId,
      reason: "STREAM_UPSTREAM_THROW",
      // 账已闭：已产出片数与已结算计量都写进 detail，调用方不必靠猜确认"花了多少"
      produced: session.produced,
      cost: session.cost,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  /**
   * 四条终局（上游结束 / 断流 / 取消 / 上游抛）汇流点：**settle + `MODEL_USAGE`，无 settle 不算完成**
   * （ADR-0003 不变式在流式路径上的落点）。`truncated` 为 false 时不写字段——正常结束的
   * 事件形状与非流式时代逐字节一致（ADR-0008 决策 4 的兼容口径）。
   */
  private async finalize(
    ref: RunRef,
    session: StreamSession,
    truncated: boolean,
  ): Promise<StreamPage> {
    if (session.finalized) {
      const page = this.settledStreams.get(session.streamId);
      if (page) return { ...page, replay: true };
      return {
        streamId: session.streamId,
        chunks: [],
        done: true,
        produced: session.produced,
        cost: session.cost,
      };
    }
    session.finalized = true;
    session.truncated = truncated;
    let cost = session.cost;
    let usageBuckets: UsageBuckets | undefined;
    let tier: PricingTierName | undefined;
    if (session.pricing) {
      // 模块没报用量 = 按 0 记（账本仍可见"这条调用没有计量"），有报则必须三桶齐全
      try {
        usageBuckets =
          session.usage === undefined
            ? { inputCached: 0, inputUncached: 0, output: 0 }
            : readUsageBuckets(session.usage);
      } catch (err) {
        await this.budget.settle(ref, session.reservationId, session.cost); // 先闭环，不留悬空预扣
        throw err;
      }
      const priced = priceUsage(session.pricing, usageBuckets, new Date(this.now()));
      cost = priced.cost;
      tier = priced.tier;
      session.cost = cost;
    }
    await this.budget.settle(ref, session.reservationId, cost);
    await this.ledger.append(ref, "MODEL_USAGE", {
      reqId: session.reqId,
      usage: session.usage,
      cost,
      ...(usageBuckets ? { usageBuckets } : {}),
      ...(tier ? { tier } : {}),
      ...(session.pricing ? { pricedBy: "manifest" as const } : {}),
      ...(truncated ? { truncated: true } : {}),
    } satisfies ModelUsagePayload);
    const page: StreamPage = {
      streamId: session.streamId,
      chunks: [],
      done: true,
      produced: session.produced,
      usage: session.usage,
      cost,
      ...(truncated ? { truncated: true } : {}),
    };
    this.settledStreams.set(session.streamId, page);
    return page;
  }
}
