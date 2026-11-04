/**
 * 表面事件写入（Phase 4 切片③，ADR-0021 决策 1/3/5 / 04 稿 R1/R3）。
 *
 * 写权结构不变：Cell 没有账本写通道，表面消息只能由 Core 侧写入；投影函数不提供写接口。
 * 本阶段只定词汇与载荷形状（`surfaceOp` 预留不实现），压缩/换页归后续 ADR。
 */

import type { Ledger } from "./ledger.js";
import { isSurfaceEventType } from "./events.js";
import type {
  LedgerEvent,
  ModelMessagePayload,
  RunRef,
  SurfaceToolCall,
  ToolResultPayload,
  TurnInputPayload,
} from "./events.js";

/**
 * 表面投影的版本号（ADR-0021 决策 2：投影带版本，重算结果与版本绑定）。
 * 改投影规则必须递增并留下重算依据。
 */
export const SURFACE_PROJECTION_VERSION = 1;

/**
 * 模型可见的一条消息（03 稿 E4 的最小形状）。
 * `reasoning` 是 DeepSeek 思考内容的回传位：带工具的第二轮漏传会直接 400。
 */
export interface SurfaceMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: SurfaceToolCall[];
  /** role=tool 专用：这条结果对应哪一次工具调用。 */
  toolCallId?: string;
}

/**
 * 纯函数投影（ADR-0021 决策 2）：只吃表面事件白名单，输出模型视图。
 * 不读账本以外的状态、不缓存、不写任何东西；结果可丢、可重算。
 *
 * 治理事件（授权/预算/裁决/效果/检查点）永远不进来——白名单在 `isSurfaceEventType`，
 * 想加一条必须走 ADR。
 */
export function projectSurface(events: readonly LedgerEvent[]): SurfaceMessage[] {
  const out: SurfaceMessage[] = [];
  for (const ev of events) {
    // 封闭白名单先挡一道：新增事件类型不会因为 switch 漏了 default 而混进模型视图。
    if (!isSurfaceEventType(ev.type)) continue;
    switch (ev.type) {
      case "TURN_INPUT": {
        const p = ev.payload as TurnInputPayload;
        out.push({ role: p.role, content: p.content });
        break;
      }
      case "MODEL_MESSAGE": {
        const p = ev.payload as ModelMessagePayload;
        out.push({
          role: "assistant",
          content: p.content,
          ...(p.reasoningContent !== undefined ? { reasoning: p.reasoningContent } : {}),
          ...(p.toolCalls !== undefined ? { toolCalls: p.toolCalls } : {}),
        });
        break;
      }
      case "TOOL_RESULT": {
        const p = ev.payload as ToolResultPayload;
        out.push({
          role: "tool",
          content: JSON.stringify(
            p.status === "ok"
              ? { status: p.status, result: p.resultDigest ?? null }
              : { status: p.status, error: p.error ?? null },
          ),
          ...(p.toolCallId !== undefined ? { toolCallId: p.toolCallId } : {}),
        });
        break;
      }
      default:
        // 白名单内的类型必须在这里有投影分支；新增白名单成员时 TypeScript 会在这里报错。
        break;
    }
  }
  return out;
}

/** 写一条 run 起始/追加的用户或系统输入。 */
export function appendTurnInput(
  ledger: Ledger,
  ref: RunRef,
  input: TurnInputPayload,
): Promise<LedgerEvent> {
  return ledger.append(ref, "TURN_INPUT", input);
}

/** 写一条模型回答（正文 + 工具调用意图 + 用量引用；`reasoningContent` 必须可回传）。 */
export function appendModelMessage(
  ledger: Ledger,
  ref: RunRef,
  message: ModelMessagePayload,
): Promise<LedgerEvent> {
  return ledger.append(ref, "MODEL_MESSAGE", message);
}
