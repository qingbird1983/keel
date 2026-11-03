/**
 * @keel/runtime-context —— Host/Cell 共用的运行上下文原语（ADR-0017）。
 *
 * 零运行时依赖：只导出类型与纯内存原语（EffectScope / RunContext）。
 */

export { EffectScope, type EffectDisposer } from "./effect-scope.js";
export {
  RunContext,
  scopeKey,
  type CapabilityName,
  type EffectIdentity,
  type EffectReceipt,
  type RunCapabilities,
  type RunNodeState,
  type RunRef,
  type Scope,
  type WorkspaceMode,
} from "./types.js";
