/**
 * 表面事件写入（Phase 4 切片③，ADR-0021 决策 1/3/5 / 04 稿 R1/R3）。
 *
 * 写权结构不变：Cell 没有账本写通道，表面消息只能由 Core 侧写入；投影函数不提供写接口。
 * 本阶段只定词汇与载荷形状（`surfaceOp` 预留不实现），压缩/换页归后续 ADR。
 */

import type { Ledger } from "./ledger.js";
import type { LedgerEvent, ModelMessagePayload, RunRef, TurnInputPayload } from "./events.js";

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
