/**
 * @keel/core —— Core 四件套（调度器/授权器/预算器/账本）+ 上下文管理器 + 模型网关 + 策略扩展点。
 *
 * 当前已落地：账本（ledger）/ 授权器（authorizer）/ 预算器（budget）；
 * 调度器、上下文管理器、模型网关、策略扩展点随纵向切片后续落地（docs/roadmap/phase-1-mvp.md）。
 */

export { ERROR_CODES, KeelError, type ErrorCode } from "./errors.js";
export {
  EVENT_TYPES,
  SCHEMA_VERSION,
  type AuthDeniedPayload,
  type BudgetReservedPayload,
  type BudgetSettledPayload,
  type CheckpointPayload,
  type CompensationClass,
  type CompensationEscalatedPayload,
  type CompensationExecutedPayload,
  type CompensationWaivedPayload,
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
