/**
 * @keel/core —— Core 四件套（调度器/授权器/预算器/账本）+ 上下文管理器 + 模型网关 + 策略扩展点。
 *
 * 当前已落地：账本 / 授权器 / 预算器 / 上下文管理器（scope 分区 + tool.discover）/ 模型网关 /
 * 策略扩展点（四 hook 白名单）/ 调度器（轮循环 + 耗尽处置）；
 * Cell 运行时、Host 装配器、补偿执行器随纵向切片后续落地（docs/roadmap/phase-1-mvp.md）。
 */

export { ERROR_CODES, KeelError, type ErrorCode } from "./errors.js";
export {
  CONTRACT_VERSION,
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  SCHEMA_VERSION,
  scopeKey,
  type AssemblyRecordedPayload,
  type AuthDeniedPayload,
  type BudgetReservedPayload,
  type BudgetSettledPayload,
  type CheckpointPayload,
  type CompensationClass,
  type CompensationEscalatedPayload,
  type CompensationExecutedPayload,
  type CompensationWaivedPayload,
  type ContextPagedPayload,
  type DecisionPayload,
  type EffectDeclaredPayload,
  type EffectSettledPayload,
  type EventType,
  type HookName,
  type HookVerdictPayload,
  type IdempotencyStrategy,
  type LedgerEvent,
  type ModelInvokedPayload,
  type ModelUsagePayload,
  type RunLifecyclePayload,
  type RunRef,
  type Scope,
  type StateSnapshotRefPayload,
  type ToolInvokePayload,
  type ToolResultPayload,
  type ToolSchemaChangedPayload,
} from "./events.js";
export { globMatch } from "./glob.js";
export {
  Ledger,
  type CheckpointInfo,
  type LedgerAppendOptions,
  type LedgerOptions,
  type LedgerPage,
  type LedgerReadFilter,
} from "./ledger.js";
export {
  Authorizer,
  type AuthDecision,
  type AuthPolicyInput,
  type AuthRule,
} from "./authorizer.js";
export {
  Budgeter,
  type BudgetLimits,
  type BudgetQuery,
  type ExhaustionMode,
  type Reservation,
} from "./budget.js";
export { ContextManager } from "./context.js";
export { ToolCatalog, type ToolEntry } from "./tool-catalog.js";
export { PageStore } from "./page-store.js";
export {
  HookBus,
  HOOK_TIMEOUT_MS,
  type BudgetExhaustedChoiceVerdict,
  type HookBusOptions,
  type HookCallResult,
  type HookHandler,
  type RetryAdviceVerdict,
  type StopAdviceVerdict,
  type ToolApprovalVerdict,
  type VerdictMap,
} from "./hooks.js";
export {
  ModelGateway,
  type ModelInvokeRequest,
  type ModelInvokeResult,
  type ModelUpstream,
  type StreamPage,
} from "./gateway.js";
export {
  STREAM_DEADLINE_MS,
  STREAM_DEFAULT_LIMIT,
  STREAM_MAX_BUFFERED,
  STREAM_WAIT_MS,
  StreamRegistry,
  type StreamPart,
  type StreamSession,
} from "./stream.js";
export {
  Scheduler,
  type ActionOutcome,
  type CompensationScope,
  type DriverAction,
  type DriverDecision,
  type PendingCompensator,
  type RunDriver,
  type RunManifest,
  type RunState,
  type RunStatus,
  type SchedulerOptions,
  type ToolExecutor,
} from "./scheduler.js";
