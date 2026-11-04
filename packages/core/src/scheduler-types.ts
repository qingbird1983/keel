/**
 * 调度器的类型面（从 `scheduler.ts` 拆出，standards/08 §4 单文件 ≤600 行）。
 * 行为实现仍在 `scheduler.ts`；这里只放调用方需要认识的形状与常量。
 */

import type { ToolEntry } from "./tool-catalog.js";
import type { AssemblyRecordedPayload, RunRef, TurnInputPayload } from "./events.js";
import type { CheckpointInfo } from "./ledger.js";

/** 工具执行通道（切片③绑定 Cell stdio；本切片注入桩/进程内实现）。 */
export type ToolExecutor = (call: {
  tool: string;
  params: unknown;
  /** 本次工具调用标识（R4）：重试沿用同一个，供 effect 去重与幂等重放。 */
  toolCallId?: string;
}) => Promise<
  { status: "ok"; result?: unknown } | { status: "error" | "timeout"; error?: unknown }
>;

export type DriverAction =
  | {
      kind: "tool";
      tool: string;
      params: unknown;
      /**
       * 发起方给出的工具调用标识（Phase 4 切片④）：engine 的 ReAct 决策带模型生成的
       * `toolCalls[].id`，下一轮投影靠它把结果配回调用。缺省 = Core 生成随机标识。
       */
      toolCallId?: string;
    }
  | {
      kind: "model";
      reqId: string;
      model: string;
      params: unknown;
      estimate: number;
    };

/** 一条动作的执行结果（内存摘要，供下一轮决策；权威记录在账本）。 */
export interface ActionOutcome {
  action: DriverAction;
  ok: boolean;
  resultDigest?: unknown;
  error?: unknown;
}

export interface RoundContext {
  run: RunRef;
  round: number;
  /** 本 scope 可见工具表（读上下文步）。 */
  tools: ToolEntry[];
  /** 上一轮动作结果。 */
  history: ActionOutcome[];
  /** 本 run 已写事件 seq（决策依据引用，V6 归因锚）。 */
  events: number[];
}

export interface DriverDecision {
  /** true = 正常完成（本轮不再执行动作）。 */
  done?: boolean;
  summary: unknown;
  actions?: DriverAction[];
  /**
   * 本决策显式引用的关键事件 seq（Phase 4 切片④ D5）：调度器把它与自身已写事件合并后
   * 作为 `DECISION.basedOn`。engine 驱动用它引用本步的 `MODEL_INVOKED` / `MODEL_USAGE` /
   * `MODEL_MESSAGE`（这些由网关/表面写入直写，不在调度器的 `h.events` 里）。
   */
  basedOn?: number[];
  /**
   * `done:true` 时的收束原因码（Phase 4 切片④）：`MAX_STEPS` 等结构性上限落
   * `RUN_HALTED{reasonCode}`，与"正常完成"（`reason:"completed"`）区分开。
   */
  haltReason?: string;
}

/** 决策来源：Host 装配时注入的 Agent 程序（非插件，不能改轮序列）。 */
export interface RunDriver {
  decide(ctx: RoundContext): Promise<DriverDecision>;
}

/** 补偿触发模式（契约 §4.1 注记⑥）：verify=T4 只核验不回滚；round=T1 本轮；run=T3/T5 全 Run。 */
export type CompensationScope = "verify" | "round" | "run";

/**
 * 补偿收尾缝（切片④：host 补偿执行器经此接入；缺省 no-op）。
 * 返回 false = 存在升级阻断（COMPENSATION_ESCALATED 未豁免），调用方落 RECOVER/COMPENSATION-FAILED。
 */
export type PendingCompensator = (mode: CompensationScope) => Promise<boolean>;

/** manifest 装配结果的最小校验面（完整五步校验随装配器切片落地）。 */
export interface RunManifest {
  ref: RunRef;
  /** Cell 授权主体（auth.check 的 subject）。 */
  subject: string;
  executor: ToolExecutor;
  driver: RunDriver;
  compensator?: PendingCompensator;
  /**
   * 装配审计基线（切片③：存在时作为本 run 首事件 ASSEMBLY_RECORDED 落账）。
   * Phase 4 切片②：profile 装配 = 逐插件一条，按声明序作为 **首批** 事件写入（01 稿 P6）。
   * 单件路径仍传单条（与旧账本逐字节一致）。
   */
  assembly?: AssemblyRecordedPayload | AssemblyRecordedPayload[];
  /** 恢复延续（契约 §4.1 注记⑦）：RUN_RECOVERED 于新 run 首事件槽写入。 */
  recoveredFrom?: { runId: string; seq: number };
  /**
   * run 起始的用户/系统输入（Phase 4 切片④，R1）：由调度器在 `RUN_STARTED` 之后、
   * 首轮之前写入 `TURN_INPUT`——表面事件只有 Core 能写，engine/插件没有账本入口。
   */
  turnInput?: TurnInputPayload;
}

/** 状态机位置（契约 run.status；recovering 随切片④恢复器启用）。 */
export type RunState = "running" | "halting" | "halted" | "failed" | "recovering";

export interface RunStatus {
  state: RunState;
  rounds: number;
  lastCheckpoint: CheckpointInfo | null;
  reasonCode?: string;
}

export interface RunHandle {
  manifest: RunManifest;
  ref: RunRef;
  round: number;
  state: RunState;
  reasonCode?: string;
  lastCheckpoint: CheckpointInfo | null;
  /** 本 run 已写事件 seq（DECISION basedOn 依据）。 */
  events: number[];
  history: ActionOutcome[];
  cancelRequested: boolean;
  /** abort 缝（切片③）：非空 = cancelRequested 由 abort 置入，终态走 RUN_FAILED。 */
  abortCode?: string;
  abortMessage?: string;
  done: Promise<RunStatus>;
  /** loop 终态结算器；done 在 loop 收束时落定。 */
  settle: (s: RunStatus) => void;
}

export const MAX_RETRIES = 3;
export const MAX_BACKOFF_MS = 30_000;

export interface SchedulerOptions {
  /** 并发 Run 上限（SCHED/BACKPRESSURE 准入）。 */
  maxConcurrentRuns?: number;
  now?: () => number;
  /** 重试退避延时注入（standards/05 §3 时间注入）；默认 setTimeout。 */
  delay?: (ms: number) => Promise<void>;
  /**
   * 快照索取缝（D3，切片④）：CHECKPOINT 落账后、ROUND_ENDED 前触发——
   * 宿主在此拉取 Cell 快照并写 STATE_SNAPSHOT_REF（I3 顺序硬约束）。
   * 快照为辅助元数据：宿主失败按尽力处理（吞错不阻断轮收束，recover.plan 报无快照）。
   */
  onCheckpoint?: (ref: RunRef, info: { seq: number; round: number }) => Promise<void>;
}
