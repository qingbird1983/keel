/**
 * 模型网关的类型面（从 `gateway.ts` 拆出，standards/08 §4 单文件 ≤600 行）。
 * 行为实现仍在 `gateway.ts`；这里只放调用方需要认识的形状与常量。
 */

import type { ModelPricing } from "./pricing.js";
import type { StreamPart } from "./stream.js";

/** 上游适配器（Core 持凭证侧；MVP 可打桩，ADR-0003）。 */
export interface ModelUpstream {
  invoke(req: { model: string; params: unknown }): Promise<{
    result: unknown;
    usage: unknown;
    /**
     * 权威计量（预算器计量单位）；旧路径实结以此为准。
     * `kind:"model"` 装配路径**不读**它：模块只报三桶用量，费用由 Core 按 manifest 价格表算，
     * 带 `cost` 反而会被当作协议违规拒绝（Phase 4 切片③ M3）。
     */
    cost?: number;
  }>;
  /**
   * 流式（[ADR-0013](../../../docs/adr/ADR-0013-model-stream-pull-chunking.md) 决策 10）：**可选**。
   * 未实现流式的上游被请求 `model.stream` = 显式失败，绝不降级成"用非流式凑一个假流"。
   * 每片自带权威计量（`cost`），`usage` 通常随末片给出。
   */
  stream?(req: { model: string; params: unknown }): AsyncIterable<StreamPart>;
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

/** 一次 `streamStart`/`streamNext` 的应答页（拉式分片的一页，ADR-0013 决策 1）。 */
export interface StreamPage {
  streamId: string;
  /** 本页分片（顺序 = 上游产出顺序）。 */
  chunks: unknown[];
  /** true = 会话已终局（不再受理 next）。 */
  done: boolean;
  /** 本会话累计已发出片数（跨页可核，调用方能自查有没有漏片）。 */
  produced: number;
  usage?: unknown;
  cost?: number;
  /** true = 断流/取消：已产出部分照常结算（决策 4）。**缺省不写** = 正常结束的页形状不变。 */
  truncated?: boolean;
  /** true = 同 reqId / 同 streamId 的重放（未重打上游、未重复预扣，决策 5）。 */
  replay?: boolean;
}

/** `kind:"model"` 装配路径注册的一条上游（Phase 4 切片③，02 稿 §5）。 */
export interface ModelRegistration {
  /** 该插件服务的模型名（manifest `model.models`；一个模块可服务多个）。 */
  models: string[];
  upstream: ModelUpstream;
  /** 该模型的价格表（manifest `model.pricing.<型号>`）；费用由 Core 计算。 */
  pricing: ModelPricing;
}

/** 非流式总时限 = 契约 §7 既有的 120s（测试注入位，不是运行期旋钮）。 */
export const MODEL_INVOKE_TIMEOUT_MS = 120_000;

export interface SettledCall {
  result: ModelInvokeResult;
}

/** 单次取片的内部结局：判别联合，四种结局各占一支（读方不必再猜"这个 object 是谁"）。 */
export type NextStep =
  | { readonly kind: "part"; readonly part: StreamPart }
  | { readonly kind: "end" }
  | { readonly kind: "stalled" }
  | { readonly kind: "failed"; readonly error: unknown };

/** 非流式上游调用的三种结局（超时是**值**不是异常，保证先 settle 再抛）。 */
export type UpstreamOutcome =
  | { readonly kind: "ok"; readonly value: Awaited<ReturnType<ModelUpstream["invoke"]>> }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };
