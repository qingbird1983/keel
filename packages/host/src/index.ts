/**
 * @keel/host —— Host Layer：IsolationProvider（进程后端，ADR-0005）、Cell Supervisor、
 * 装配器（五步校验 + 热装配，manifest 稿 §6）、Core 侧 Cell 通道服务（契约 §3.3）、
 * 补偿执行器（补偿稿 T01~T14）、恢复管理器（契约 §4.5）、快照存储（D3）。
 *
 * 已落地（切片③④ + Phase 2 切片①②）：进程后端 / Supervisor 生命周期与退出三分类 / 装配五步校验 /
 * 热装配与回退 / effect.declare 服务端（C-M1 焊点）/ 效果追踪与结算 / 补偿投影与编排 /
 * recover.plan/execute / 轮边界快照索取缝 / 声明→规则编译 / 运行期注册通道服务端 / 装配收敛点 wireCell（含就绪探测）/
 * 策略插件装配链 wirePolicies（切片④，ADR-0012）。
 */

export {
  ProcessIsolationProvider,
  sanitizedEnv,
  type CellProcess,
  type IsolationProvider,
  type SpawnSpec,
} from "./isolation.js";
export { validateSchema, type SchemaIssue } from "./schema-validator.js";
export {
  Assembler,
  BOUNDARY_CAPS,
  KINDS,
  MODEL_TOTAL_TIMEOUT_MAX_MS,
  TOOL_CALL_TIMEOUT_MAX_MS,
  rangeContains,
  type AssemblerOptions,
  type CompensationTemplateDecl,
  type EngineDecl,
  type GovernanceEffectDecl,
  type GovernanceGuardDecl,
  type GovernanceToolDecl,
  type LoadedManifest,
  type ManifestKind,
  type MigrationDecl,
  type ModelDecl,
  type ModelPricing,
  type PeakWindow,
  type PermissionDecl,
  type PricingTier,
} from "./assembler.js";
export {
  assembleProfile,
  loadProfile,
  type AssembledProfilePlugin,
  type AssembleProfileOptions,
  type LoadProfileOptions,
  type ProfileAssembly,
  type ProfilePlan,
  type ProfilePluginPlan,
} from "./profile/assemble.js";
export { parseYamlSubset } from "./profile/parse.js";
export { validateProfileDocument } from "./profile/schema.js";
export { compileGovernancePlan } from "./governance.js";
export {
  AssemblyManager,
  type BindRequest,
  type CellFactory,
  type HotSwapRequest,
  type ManagedCell,
  type ScopeBinding,
} from "./assembly-manager.js";
export {
  CELL_EXIT_REASON,
  CellSupervisor,
  ENGINE_STEP_TIMEOUT_MS,
  SupervisedCell,
  type CellExit,
  type CellExitClass,
  type CellPhase,
  type DrainOutcome,
  type SupervisorOptions,
} from "./supervisor.js";
export {
  EngineDriver,
  EngineProtocolError,
  GracefulExhaustion,
  modelEventsOf,
  type EngineDriverOptions,
  type EngineStepInput,
  type EngineStepResponse,
} from "./engine-driver.js";
export { serveCellChannel, type CellChannelBinding, type CellServerDeps } from "./cell-server.js";
export { manifestAuthRules, capabilitysWithoutRuntimeOp } from "./permission-rules.js";
export {
  CELL_READY_TIMEOUT_MS,
  wireCell,
  type WireCellParams,
  type WiredCell,
} from "./wire-cell.js";
export {
  wirePolicies,
  type PolicyBinding,
  type PolicySummary,
  type PolicySpec,
  type WirePoliciesParams,
} from "./policy-link.js";
export {
  OBSERVED_ACTION_CAPS,
  contractRange,
  synthesizeManifest,
  synthesizeName,
  type GapCode,
  type SynthesisGap,
  type SynthesisInput,
  type SynthesizedCandidate,
} from "./manifest-synthesis.js";
export {
  CompensationExecutor,
  type ActionCellFactory,
  type CompensationActionCell,
  type CompensationExecutorOptions,
  type EffectProjectionEntry,
  type EffectState,
  type ToolResultLike,
} from "./compensator.js";
export {
  BUILTIN_REFS,
  DEFAULT_BUILTINS,
  FS_REMOVE,
  RECORD_ONLY_REF,
  type BuiltinAction,
  type BuiltinActionContext,
  type RunPermissionView,
} from "./builtins.js";
export { EffectTracker, type DeclaredEffectMeta } from "./effects.js";
export {
  Workspace,
  deriveWorkspaceRoot,
  identityMatches,
  matchPath,
  resourceOf,
  type WorkspaceWriteInput,
  type WorkspaceWriteResult,
} from "./workspace.js";
export { SnapshotStore, type SnapshotEntry } from "./snapshot.js";
export { RecoveryManager, type RecoveredContinuation, type RecoveryPlan } from "./recovery.js";
export {
  SessionLease,
  type LeaseHandle,
  type LeaseRecord,
  type SessionLeaseOptions,
} from "./session/lease.js";
export { projectSessionBudget } from "./session/budget.js";
export {
  MAX_SUMMARY_CHARS,
  compactSession,
  type CompactSessionOptions,
} from "./session/compact.js";
