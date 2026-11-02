/**
 * @keel/host —— Host Layer：IsolationProvider（进程后端，ADR-0005）、Cell Supervisor、
 * 装配器（五步校验 + 热装配，manifest 稿 §6）、Core 侧 Cell 通道服务（契约 §3.3）。
 *
 * 已落地（切片③）：进程后端 / Supervisor 生命周期与退出三分类 / 装配五步校验 /
 * 热装配与回退 / effect.declare 服务端（C-M1 焊点）。
 * 补偿执行器随切片④（补偿状态机 T01~T14 + recover.*）接入。
 */

export {
  ProcessIsolationProvider,
  type CellProcess,
  type IsolationProvider,
  type SpawnSpec,
} from "./isolation.js";
export { validateSchema, type SchemaIssue } from "./schema-validator.js";
export {
  Assembler,
  KINDS,
  TOOL_CALL_TIMEOUT_MAX_MS,
  rangeContains,
  type AssemblerOptions,
  type CompensationTemplateDecl,
  type LoadedManifest,
  type ManifestKind,
  type MigrationDecl,
  type PermissionDecl,
} from "./assembler.js";
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
  SupervisedCell,
  type CellExit,
  type CellExitClass,
  type CellPhase,
  type SupervisorOptions,
} from "./supervisor.js";
export { serveCellChannel, type CellChannelBinding, type CellServerDeps } from "./cell-server.js";
