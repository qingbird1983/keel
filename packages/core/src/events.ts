/**
 * 账本事件模型 —— 契约 §5 事件表 + 补偿状态机 §9 载荷增量。
 * 信封：{seq( Run 内单调), ts, runId, sessionId, agentId, type, schemaVersion, payload}。
 */

/** 作用域 = (agentId, sessionId)（契约 §3.2）；不存在无作用域的全局接口。 */
export interface Scope {
  agentId: string;
  sessionId: string;
}

/** Run 引用 = 作用域 + runId；Cell ↔ Run 一一对应。 */
export interface RunRef extends Scope {
  runId: string;
}

/** 作用域内部寻址键（budget / context 等按 scope 分区的组件共用）。 */
export function scopeKey(s: Scope): string {
  return `${s.agentId}|${s.sessionId}`;
}

export const SCHEMA_VERSION = 1;

/** 契约 §5 全部事件类型（含状态机 §9 三类增量），封闭集合。 */
export const EVENT_TYPES = [
  "RUN_STARTED",
  "RUN_HALTED",
  "RUN_FAILED",
  "RUN_RECOVERED",
  "ASSEMBLY_RECORDED",
  "ROUND_STARTED",
  "ROUND_ENDED",
  "DECISION",
  "TOOL_INVOKE",
  "TOOL_RESULT",
  "AUTH_DENIED",
  "HOOK_CALLED",
  "HOOK_VERDICT",
  "BUDGET_RESERVED",
  "BUDGET_SETTLED",
  "MODEL_INVOKED",
  "MODEL_USAGE",
  "EFFECT_DECLARED",
  "EFFECT_SETTLED",
  "COMPENSATION_EXECUTED",
  "COMPENSATION_ESCALATED",
  "COMPENSATION_WAIVED",
  "STATE_SNAPSHOT_REF",
  "TOOL_SCHEMA_CHANGED",
  "CONTEXT_PAGED",
  "CHECKPOINT",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * **按事件类型**的载荷格式版本（切片⑤ §7 第 1 项，所有者确认）。
 *
 * 为什么不全局递增：全局那枚 `SCHEMA_VERSION` 等于宣告"所有事件类型都改过格式"，而实际改的
 * 只有个别类型的载荷（追加字段）。表里没列的类型 = `SCHEMA_VERSION`（1）。
 * 读方一律按**字段缺省**容错，不按版本号分支——版本号是给审计员看的，不是行为开关。
 */
export const EVENT_SCHEMA_VERSION: Partial<Record<EventType, number>> = {
  /** v2 = 追加依据上界 `throughSeq`（[ADR-0008](../../../docs/adr/ADR-0008-decision-attribution-upper-bound.md) 决策 2）。 */
  DECISION: 2,
  /** v2 = 流式会话追加 `streamId`（[ADR-0013](../../../docs/adr/ADR-0013-model-stream-pull-chunking.md) 决策 3/8）。 */
  MODEL_INVOKED: 2,
  /** v2 = 追加 `truncated`（断流时"已产出部分结算"的可见标记，ADR-0013 决策 4）。 */
  MODEL_USAGE: 2,
};

/** 账本事件信封（契约 §5 公共信封）。 */
export interface LedgerEvent {
  seq: number;
  ts: number;
  runId: string;
  sessionId: string;
  agentId: string;
  type: EventType;
  schemaVersion: number;
  payload: unknown;
}

/* ── 各事件载荷（契约 §5 载荷要点 / 状态机 §9）────────────────────────── */

export interface RunLifecyclePayload {
  reason?: string;
  reasonCode?: string;
  /** RUN_RECOVERED 专用：延续后的新 runId 与恢复自的一致点 seq。 */
  newRunId?: string;
  recoveredFromSeq?: number;
}

/**
 * Core API 契约版本（manifest compat.keelContract 的协商对象；装配器版本校验用）。
 * 契约语义级变更时递增（manifest 稿 §5.5）。
 */
export const CONTRACT_VERSION = "1.0.0";

/** 装配审计基线（manifest 稿 §6 第 5 步；切片③：run.start 首事件）。 */
export interface AssemblyRecordedPayload {
  manifest: { name: string; version: string; kind: string };
  /** 权限清单（cap + allow 限定符，装配时就已裁决的面）。 */
  permissions: { cap: string; allow?: string[] }[];
  /** 补偿模板摘要（record-only 标记 = class 字段本身）。 */
  compensation: { kind: string; compensationClass: string; idempotency: string }[];
  /** 热装配升级时被替换的旧版本（V5：被切换的是作用域绑定，无全局突变）。 */
  replacesVersion?: string;
  /**
   * 本 run 绑定的策略插件与各自申领的插话点（切片④ 回填项 ①，ADR-0012 决策 6）。
   * **追加字段**：缺省不写（没绑策略的运行与 Phase 1 的旧账本样例形状不变、仍可读）。
   * 动机是 V6 的可回答性——策略不插话时账本对它零记录，"绑了但没说话"必须还能与"根本没绑"分辨。
   */
  policies?: { name: string; version: string; hooks: string[] }[];
}

export interface RoundPayload {
  round: number;
}

/**
 * V6 归因锚点（ADR-0008 决策 1/2 的落地形状）：
 * - `basedOn` = **本决策显式引用的关键事件** seq（授权拒绝、策略裁决、失败结果等），
 *   不是"决策前全部事件"——账本并非单一写入者（`AUTH_DENIED`/`BUDGET_*`/`MODEL_*`/`EFFECT_*`/
 *   `STATE_SNAPSHOT_REF` 按设计由组件直写），全量枚举既做不到也不带来新信息。
 * - `throughSeq` = 本决策写入前该 run 账本里已存在的**最大事件编号**（依据上界，ADR-0008 决策 2）：
 *   任何直写事件都在上界之内，不再出现"这条确实发生过却不在任何依据列表里"。
 *   由**账本在写队列执行期盖章**（`Ledger.append` 的 `stampSeqBeforeAs`）——seq 在执行期分配，
 *   调用方自读会漏掉"读之后、写之前"落账的那笔，恰是本字段要修的错误类型。
 * - **追加字段：缺省不写**，Phase 1 的旧账本样例仍可读（读方按"无显式上界"处理，决策 4）。
 */
export interface DecisionPayload {
  round: number;
  summary: unknown;
  basedOn: number[];
  throughSeq?: number;
}

export interface ToolInvokePayload {
  round: number;
  tool: string;
  paramsDigest: unknown;
}

export interface ToolResultPayload {
  round: number;
  tool: string;
  status: "ok" | "error" | "timeout";
  durationMs: number;
  resultDigest?: unknown;
  error?: unknown;
}

export interface AuthDeniedPayload {
  subject: string;
  action: string;
  resource: string;
  policyVersion: string;
  reason: string;
}

export interface HookCalledPayload {
  hook: HookName;
  round: number;
}

export interface HookVerdictPayload {
  hook: HookName;
  round: number;
  verdict: unknown;
  /** hook 失败/超时 = 采用默认策略并置 fallback:true（契约 §4.8）。 */
  fallback: boolean;
}

export type HookName = "toolApproval" | "stopAdvice" | "retryAdvice" | "budgetExhaustedChoice";

export interface BudgetReservedPayload {
  reservationId: string;
  reqId: string;
  estimate: number;
  runRemaining: number | null;
  sessionRemaining: number | null;
}

export interface BudgetSettledPayload {
  reservationId: string;
  actual: number;
  refund: number;
  runRemaining: number | null;
  sessionRemaining: number | null;
}

/**
 * 模型调用留痕（ADR-0003 时序：一次调用一条）。
 * **追加字段** `streamId`（ADR-0013 决策 3）：流式调用的会话标识；非流式为缺省（不写）。
 * 每片**不写事件**——否则账本体积变成流长度的函数。
 */
export interface ModelInvokedPayload {
  model: string;
  reqId: string;
  requestDigest: unknown;
  streamId?: string;
}

/**
 * 用量与权威计量（流式在**流终了**写这一条，ADR-0013 决策 3/4）。
 * **追加字段** `truncated`：true = 会话未自然结束（断流/取消/超总长），已产出部分照常结算。
 */
export interface ModelUsagePayload {
  reqId: string;
  usage: unknown;
  cost: number;
  truncated?: boolean;
}

/** 补偿分级（状态机 §7，manifest 必填枚举）。 */
export type CompensationClass = "reversible" | "mitigable" | "record-only";

/** 幂等策略三选一（状态机 §6）。 */
export type IdempotencyStrategy = "natural" | "keyed" | "probe-guarded";

export interface EffectDeclaredPayload {
  effectId: string;
  kind: string;
  targetSummary: unknown;
  compensationClass: CompensationClass;
  compensation: {
    actionRef: string;
    paramsDigest: unknown;
    idempotency: IdempotencyStrategy;
  };
  probeRef: string | null;
  dependsOn: string[];
  retention: unknown;
}

export interface EffectSettledPayload {
  effectId: string;
  outcome: "done" | "failed-clean" | "unknown";
  error?: unknown;
  usageDigest?: unknown;
}

export interface CompensationExecutedPayload {
  effectId: string;
  attempt: number;
  resultDigest: unknown;
  durationMs: number;
}

export interface CompensationEscalatedPayload {
  effectId: string;
  attempts: number;
  lastError: unknown;
  blockedResume: true;
}

export interface CompensationWaivedPayload {
  effectId: string;
  waivedBy: string;
  reason: string;
}

export interface StateSnapshotRefPayload {
  ref: string;
  version: number;
  round: number;
}

export interface ToolSchemaChangedPayload {
  tool: string;
  oldSchemaVersion: number;
  newSchemaVersion: number;
  /** 仅传播到受影响 scope（V1）；null 表示跨 scope 广播（如全局工具下线）。 */
  affectedScope: Scope | null;
}

/** 换页审计（契约 §4.6 切片④注记：页版本入账本）。 */
export interface ContextPagedPayload {
  pageId: string;
  direction: "out" | "in";
  version: number;
}

export interface CheckpointPayload {
  round: number;
}
