/**
 * 表面事件写入（Phase 4 切片③，ADR-0021 决策 1/3/5 / 04 稿 R1/R3）。
 *
 * 写权结构不变：Cell 没有账本写通道，表面消息只能由 Core 侧写入；投影函数不提供写接口。
 * 本阶段只定词汇与载荷形状（`surfaceOp` 预留不实现），压缩/换页归后续 ADR。
 */

import type { Ledger } from "./ledger.js";
import type { SessionEvent } from "./session.js";
import { isSurfaceEventType } from "./events.js";
import type {
  LedgerEvent,
  ModelMessagePayload,
  RunRef,
  SurfaceCompactedPayload,
  SurfaceToolCall,
  ToolResultPayload,
  TurnInputPayload,
} from "./events.js";

/**
 * 表面投影的版本号（ADR-0021 决策 2：投影带版本，重算结果与版本绑定）。
 * 改投影规则必须递增并留下重算依据。
 *
 * v2（Phase 5 R4）：规则集扩到跨 run 会话流（`projectSession`）；压缩标记的折叠
 * 属同一规则集，随切片④落地（ADR-0026）。
 */
export const SURFACE_PROJECTION_VERSION = 2;

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
    const message = projectEvent(ev);
    if (message) out.push(message);
  }
  return out;
}

export interface ProjectSessionOptions {
  /**
   * true = **还原口径**（03 稿 §3）：忽略全部压缩标记与遮蔽，重算出未压缩视图。
   * 默认 false = 按标记折叠（最新摘要为准）。
   */
  includeCompacted?: boolean;
}

/**
 * 会话投影（Phase 5 R4/R5）：同一会话的多个 run 共用一条模型视图。
 *
 * 顺序由调用方保证（`SessionReader.read` 已按会话流排序）；本函数仍只吃白名单，
 * 不读 runId、不看时间——同一事件流 + 同一版本 = 同一输出（E1 的重算断言）。
 *
 * 压缩折叠（两遍，ADR-0026）：先收集全部标记的复合区间，再按序投影；被遮蔽的地址跳过，
 * 未被遮蔽的标记以 `system` 消息出现；标记自身若被更晚的标记遮蔽，连摘要一起丢弃
 * （"最新摘要为准"）。`includeCompacted:true` 时两者都不生效 = 还原。
 */
export function projectSession(
  events: readonly SessionEvent[],
  opts: ProjectSessionOptions = {},
): SurfaceMessage[] {
  const includeCompacted = opts.includeCompacted === true;
  const shadowed = includeCompacted ? new Set<string>() : shadowedAddresses(events);
  // 摘要放在**被遮蔽区间的起点**（而不是标记自己的位置）：视图顺序是"摘要 + 最近的保留消息"，
  // 与 03 稿 §3 的"摘要 + 最近若干条"一致。被更晚标记取代的旧摘要不出现。
  const summaries = new Map<string, string>();
  if (!includeCompacted) {
    for (const se of events) {
      if (se.event.type !== "SURFACE_COMPACTED") continue;
      if (shadowed.has(addressOf(se))) continue; // 被更晚的摘要取代
      const p = se.event.payload as SurfaceCompactedPayload;
      const first = p.shadowed[0];
      if (first) summaries.set(`${first.from.runId}#${first.from.seq}`, p.summary);
    }
  }
  const out: SurfaceMessage[] = [];
  for (const se of events) {
    const key = addressOf(se);
    const summary = summaries.get(key);
    if (summary !== undefined) out.push({ role: "system", content: summary });
    if (se.event.type === "SURFACE_COMPACTED") continue; // 标记本身不是消息
    if (!includeCompacted && shadowed.has(key)) continue;
    const message = projectEvent(se.event);
    if (message) out.push(message);
  }
  return out;
}

/** 带地址的表面消息（压缩择区间用：消息组边界需要回指到账本地址）。 */
export interface SessionSurfaceEntry {
  runOrdinal: number;
  runId: string;
  seq: number;
  message: SurfaceMessage;
}

/** 与 `projectSession` 同口径的"逐条消息"视图（不含压缩标记自身的 system 消息）。 */
export function projectSessionEntries(
  events: readonly SessionEvent[],
  opts: ProjectSessionOptions = {},
): SessionSurfaceEntry[] {
  const includeCompacted = opts.includeCompacted === true;
  const shadowed = includeCompacted ? new Set<string>() : shadowedAddresses(events);
  const out: SessionSurfaceEntry[] = [];
  for (const se of events) {
    if (se.event.type === "SURFACE_COMPACTED") continue;
    if (!includeCompacted && shadowed.has(addressOf(se))) continue;
    const message = projectEvent(se.event);
    if (message) {
      out.push({ runOrdinal: se.runOrdinal, runId: se.runId, seq: se.event.seq, message });
    }
  }
  return out;
}

/** 会话里被压缩标记遮蔽的地址集合（`runId#seq`）。 */
function shadowedAddresses(events: readonly SessionEvent[]): Set<string> {
  const ordinal = new Map<string, number>();
  for (const se of events) if (!ordinal.has(se.runId)) ordinal.set(se.runId, se.runOrdinal);
  const out = new Set<string>();
  for (const se of events) {
    if (se.event.type !== "SURFACE_COMPACTED") continue;
    const p = se.event.payload as SurfaceCompactedPayload;
    for (const range of p.shadowed) {
      const from = ordinal.get(range.from.runId);
      const to = ordinal.get(range.to.runId);
      if (from === undefined || to === undefined) continue; // 区间指向不在本流的 run：忽略
      for (const target of events) {
        const o = target.runOrdinal;
        const afterFrom = o > from || (o === from && target.event.seq >= range.from.seq);
        const beforeTo = o < to || (o === to && target.event.seq <= range.to.seq);
        if (afterFrom && beforeTo) out.add(addressOf(target));
      }
    }
  }
  return out;
}

function addressOf(se: SessionEvent): string {
  return `${se.runId}#${se.event.seq}`;
}

/** 单条事件的表面映射；白名单之外一律 null（新增类型不会因 switch 漏 default 混进视图）。 */
function projectEvent(ev: LedgerEvent): SurfaceMessage | null {
  if (!isSurfaceEventType(ev.type)) return null;
  switch (ev.type) {
    case "TURN_INPUT": {
      const p = ev.payload as TurnInputPayload;
      return { role: p.role, content: p.content };
    }
    case "MODEL_MESSAGE": {
      const p = ev.payload as ModelMessagePayload;
      return {
        role: "assistant",
        content: p.content,
        ...(p.reasoningContent !== undefined ? { reasoning: p.reasoningContent } : {}),
        ...(p.toolCalls !== undefined ? { toolCalls: p.toolCalls } : {}),
      };
    }
    case "TOOL_RESULT": {
      const p = ev.payload as ToolResultPayload;
      return {
        role: "tool",
        content: JSON.stringify(
          p.status === "ok"
            ? { status: p.status, result: p.resultDigest ?? null }
            : { status: p.status, error: p.error ?? null },
        ),
        ...(p.toolCallId !== undefined ? { toolCallId: p.toolCallId } : {}),
      };
    }
    default:
      // 白名单内的类型必须在这里有投影分支；新增白名单成员时 TypeScript 会在这里报错。
      return null;
  }
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
