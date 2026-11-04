/**
 * Cell 运行时的跨包视图类型（从 `cell.ts` 拆出，standards/08 §4 单文件 ≤600 行）。
 * 行为实现仍在 `cell.ts`；这里只放入口/插件需要认识的形状。
 */

import type { CellClient } from "./cell.js";

/** 内核指派的工具视图（tool.register 返回；Cell 侧不得自算版本，ADR-0010 决策 4）。 */
export interface RegisteredToolView {
  name: string;
  schemaVersion: number;
}

/** 舱内可见的流式应答形状（与 core 的 `StreamPage` 同形，跨包零依赖）。 */
export interface StreamPageView {
  streamId: string;
  chunks: unknown[];
  done: boolean;
  produced: number;
  usage?: unknown;
  cost?: number;
  truncated?: boolean;
  replay?: boolean;
}

/**
 * engine 插件的一步（Phase 4 切片④，03 稿 E1/E3；ADR-0023）：
 * Host 每步发一次 `engine.step`，插件在一步内调模型并返回决策。
 * **没有工具执行通道**——工具调用由 Core 执行，engine 只返回意图。
 */
export interface EngineStepContext {
  /** 业务能力出口（本切片只用到模型调用；工具执行不在这里）。 */
  readonly client: CellClient;
  /** 报关单 `engine` 段（宿主经 bootstrap 送达；模块不自报）。 */
  readonly engine: unknown;
}

export type EngineStepHandler = (
  input: unknown,
  ctx: EngineStepContext,
) => Promise<unknown> | unknown;
