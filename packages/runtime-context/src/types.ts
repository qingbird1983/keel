/**
 * 运行上下文共享类型（ADR-0017）——零依赖，不做 IO / 授权 / 账本裁决。
 *
 * 这里放 Host 与 Cell 都要用的**形状**：作用域、节点状态、能力名、效果收据。
 * 行为在 @keel/core（账本/授权）、@keel/host（Workspace）与 @keel/cell-runtime（拦截器）里。
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

/** 插件节点状态（Cordis Fiber 的收敛版；宿主可观测，不进业务账本）。 */
export type RunNodeState = "pending" | "loading" | "active" | "failed" | "unloading" | "disposed";

/** 受治理写入模式（ADR-0018）：create = 独占新建；overwrite = 显式覆盖（无内置补偿）。 */
export type WorkspaceMode = "create" | "overwrite";

/** 文件身份：创建/覆盖后从实际句柄读取，补偿前重新核对。 */
export interface EffectIdentity {
  /** 设备号（字符串化，避免 BigInt 跨通道序列化）。 */
  dev: string;
  /** inode（字符串化；Windows 上可能为 0）。 */
  ino: string;
  size: number;
  mtimeMs: number;
  /** 内容 SHA-256（hex）；用于删除前确认文件未被替换。 */
  sha256: string;
}

/**
 * 效果收据（ADR-0018）：只证明“这次受治理操作确实发生”，不证明业务语义。
 * `created:true` 是内置 `fs.remove` 的唯一入口条件。
 */
export interface EffectReceipt {
  /** 对应 EFFECT_DECLARED.effectId；Host 侧核对归属后写入。 */
  opId: string;
  kind: string;
  mode: WorkspaceMode;
  /** 绝对目标路径（已归一）。 */
  target: string;
  /** 命中的写入根（来自 fs.write.allow 的 `/**` 前缀）；无法确定时为 null。 */
  workspaceRoot: string | null;
  /** 操作前目标是否存在。 */
  existed: boolean;
  /** 本次是否新建（只有 create 且独占成功才为 true）。 */
  created: boolean;
  /** 是否覆盖了既有内容（overwrite 且 existed=true）。 */
  overwritten: boolean;
  /** 操作后的实际身份；失败/未发生时可缺省。 */
  identity?: EffectIdentity;
  /** 覆盖写前的可选摘要（本阶段不保存旧内容）。 */
  before?: unknown;
  timestamp: number;
}

/** Run 侧可见能力名（封闭集合；不是字符串服务注册表）。 */
export type CapabilityName = "workspace" | "model" | "ledger" | "effects" | "logger";

/** Run 能力句柄袋；未授予的能力在构造期缺失，运行期访问即错（fail-closed）。 */
export interface RunCapabilities {
  readonly workspace?: unknown;
  readonly model?: unknown;
  readonly ledger?: unknown;
  readonly effects?: unknown;
  readonly logger?: unknown;
}

/**
 * Run Context：每 Run 一份，创建后冻结。
 * 本阶段只承载“Run 身份 + 能力袋”；服务替换不在 Run 内发生（ADR-0017 决策 2）。
 */
export class RunContext<C extends object = RunCapabilities> {
  readonly ref: RunRef;
  readonly capabilities: Readonly<C>;

  constructor(ref: RunRef, capabilities: C) {
    this.ref = Object.freeze({ ...ref });
    this.capabilities = Object.freeze({ ...capabilities });
    Object.freeze(this);
  }
}
