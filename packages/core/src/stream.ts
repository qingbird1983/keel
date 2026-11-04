/**
 * 流式会话表 —— ADR-0013 决策 1/2 的内核侧落点（`model.stream` 是**拉式分片**）。
 *
 * 形状要点（为什么是这样，见 ADR-0013 背景与理由）：
 * - 消费方（Cell）不 `next` 就不向上游取片 → **背压由构造消解**，不需要额外的流控机制；
 * - 每一片仍是一请求一响应的内容，帧协议不变（"一请求一响应"是 Supervisor 三处超时的地基）；
 * - 会话状态住在内核进程里：宿主重启即全部中断（Phase 3 若要"续流"须另立决策）；
 * - **每片不写账本事件**：一次流式调用 = 一条 `MODEL_INVOKED`（含 `streamId`）+ 一条
 *   `MODEL_USAGE`（终了，含权威计量与 `truncated`）。
 */

import type { RunRef } from "./events.js";
import type { ModelPricing } from "./pricing.js";

/**
 * 上游产出的一片：`cost` 是该片的权威计量（旧路径；可为 0），`usage` 可只在末片给出。
 * `kind:"model"` 装配路径**不读** `cost`（费用由 Core 按 manifest 价格表算），
 * 模块带 `cost` 会被网关当作协议违规拒绝。
 */
export interface StreamPart {
  chunk: unknown;
  cost?: number;
  usage?: unknown;
}

/** 一次流式调用的内核侧会话（宿主重启不续，见文件头）。 */
export interface StreamSession {
  streamId: string;
  reqId: string;
  /** 归属作用域与授权主体：next/cancel 只在**同一 run 同一主体**内受理（防猜 id 越界取片）。 */
  ref: RunRef;
  subject: string;
  model: string;
  /** 预扣凭据（start 时一次；ADR-0013 决策 3 的"无 settle 不算完成"靠它）。 */
  reservationId: string;
  /** 上游迭代器（未实现流式 = 根本没有会话）。 */
  iterator: AsyncIterator<StreamPart>;
  startedAt: number;
  /** 已累加的权威计量。 */
  cost: number;
  /** 最近一次上游报的用量（末片给）。 */
  usage: unknown;
  produced: number;
  /** 终态：上游正常结束 / 断流 / 取消，三条都走 finalize（settle + MODEL_USAGE）。 */
  finalized: boolean;
  /** finalize 时是否截断（true = 已产出部分结算，ADR-0013 决策 4）。 */
  truncated: boolean;
  /** 已注册模型的 manifest 价格表（Phase 4 切片③）；缺省 = 旧的"每片自带 cost"路径。 */
  pricing?: ModelPricing;
}

/** 时限默认值 = 契约 §7 既有三档（**不新增时限数**；构造参数只是测试注入位）。 */
export const STREAM_WAIT_MS = 30_000; // 流式首字节 / 单次取片等待上限
export const STREAM_DEADLINE_MS = 300_000; // 流式总长（会话自 start 起计时）
/** 单次 `next` 默认取片上限与缓冲硬顶（ADR-0013 后果③：实现期参数，不锁进 ADR）。 */
export const STREAM_DEFAULT_LIMIT = 16;
export const STREAM_MAX_BUFFERED = 64;

/**
 * 会话登记与归属校验。生命周期只有一条规则：**finalized 即不再受理**（幂等重放走网关的
 * 已结算表，不在这里）。
 */
export class StreamRegistry {
  private readonly byId = new Map<string, StreamSession>();
  private readonly byReqId = new Map<string, StreamSession>();
  private seq = 0;

  /** 会话 id：进程内唯一 + 带 reqId 前缀（审计读账本时能一眼对上请求号）。 */
  newStreamId(reqId: string): string {
    return `stm-${++this.seq}-${reqId}`;
  }

  add(session: StreamSession): void {
    this.byId.set(session.streamId, session);
    this.byReqId.set(session.reqId, session);
  }

  get(streamId: string): StreamSession | undefined {
    return this.byId.get(streamId);
  }

  byReq(reqId: string): StreamSession | undefined {
    return this.byReqId.get(reqId);
  }

  /**
   * 归属校验（ADR-0013 决策 1 的"作用域由通道盖章"那一半）：`streamId` 是标识符不是权限——
   * 猜到一个 id 也不该取到别人的分片。不符 = 当作不存在（不区分"没有"与"不是你的"，
   * 免得给跨 run 探测留一条差分信道）。
   */
  owned(streamId: string, ref: RunRef, subject: string): StreamSession | undefined {
    const s = this.byId.get(streamId);
    if (!s) return undefined;
    if (
      s.ref.runId !== ref.runId ||
      s.ref.agentId !== ref.agentId ||
      s.ref.sessionId !== ref.sessionId
    )
      return undefined;
    return s.subject === subject ? s : undefined;
  }

  /** 未终会话计数（测试与观测用）。 */
  get openCount(): number {
    let n = 0;
    for (const s of this.byId.values()) if (!s.finalized) n++;
    return n;
  }
}
