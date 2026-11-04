/**
 * 会话压缩（Phase 5 R5，03 稿 §3~§5 / ADR-0026）。
 *
 * 压缩是**视图操作**：账本里只加一条 `SURFACE_COMPACTED`，原始事件永不改删；
 * 摘要由一次**受治理**的模型调用生成（网关：授权 / 预扣 / 结算 / `MODEL_*` 事件成对）。
 * 本模块不碰 HTTP、不读密钥、不写治理事件。
 */

import {
  SURFACE_PROJECTION_VERSION,
  projectSessionEntries,
  type Ledger,
  type ModelGateway,
  type RunRef,
  type SessionEvent,
  type SurfaceCompactedPayload,
  type SurfaceMessage,
  type SurfaceShadowRange,
} from "@keel/core";

/** 摘要正文上限（03 稿 §3）：超限拒绝写，不截断、不静默。 */
export const MAX_SUMMARY_CHARS = 8_192;

export interface CompactSessionOptions {
  ledger: Ledger;
  gateway: ModelGateway;
  /** 本次 run（标记与摘要调用都落在它下面）。 */
  ref: RunRef;
  /** 会话历史（本次 run 之前的事件，按会话流排序）。 */
  events: readonly SessionEvent[];
  /** 摘要用的模型名（必须是本 profile 已注册的模型）。 */
  model: string;
  /** 保留最近多少条消息（默认 6）；按消息组边界切，不拆"调用 + 结果"。 */
  keepRecent?: number;
  reason: "manual" | "threshold";
}

/**
 * 执行一次压缩；没有可遮蔽内容 / 摘要为空或超限时返回 null（不写标记）。
 * 模型调用失败会抛出（由调用方按"压缩失败不阻断任务"处理）。
 */
export async function compactSession(
  opts: CompactSessionOptions,
): Promise<SurfaceCompactedPayload | null> {
  const entries = projectSessionEntries(opts.events, { includeCompacted: true });
  if (entries.length === 0) return null;
  const messages = entries.map((e) => e.message);
  const keepRecent = Math.max(1, Math.trunc(opts.keepRecent ?? 6));
  const cut = cutIndex(messages, keepRecent);
  // 会话开头的 system 提示永不遮蔽（03 稿 §3.1）
  const firstSystem = messages[0]?.role === "system" ? 1 : 0;
  if (cut <= firstSystem) return null;
  const target = entries.slice(firstSystem, cut);
  const shadowed = rangesOf(target);
  if (shadowed.length === 0) return null;

  const reqId = `compact:${opts.ref.runId}`;
  const result = await opts.gateway.invoke(opts.ref, opts.ref.agentId, {
    reqId,
    model: opts.model,
    params: {
      purpose: "compaction",
      messages: target.map((e) => e.message),
    },
    estimate: 1,
  });
  const content = (result.result as { content?: unknown } | null | undefined)?.content;
  if (typeof content !== "string" || content.trim() === "") return null;
  if (content.length > MAX_SUMMARY_CHARS) return null;

  const payload: SurfaceCompactedPayload = {
    summary: content,
    shadowed,
    reason: opts.reason,
    usageRef: { reqId },
    projectionVersion: SURFACE_PROJECTION_VERSION,
  };
  await opts.ledger.append(opts.ref, "SURFACE_COMPACTED", payload);
  return payload;
}

/**
 * 遮蔽区间 = 保留窗口之前的前缀；切点必须落在**消息组边界**：
 * 一条带 `toolCalls` 的 assistant 消息 + 紧随其后的 tool 结果是一组，组不可拆分。
 */
function cutIndex(messages: readonly SurfaceMessage[], keepRecent: number): number {
  const groups = messageGroups(messages);
  let kept = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]!;
    kept += group.end - group.start;
    if (kept >= keepRecent) return group.start;
  }
  return 0;
}

function messageGroups(messages: readonly SurfaceMessage[]): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  for (let i = 0; i < messages.length;) {
    const start = i;
    const m = messages[i]!;
    i += 1;
    if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      while (i < messages.length && messages[i]!.role === "tool") i += 1;
    }
    groups.push({ start, end: i });
  }
  return groups;
}

/** 把前缀消息折成按 run 分段的闭区间（同一 run 连续段合并）。 */
function rangesOf(entries: readonly { runId: string; seq: number }[]): SurfaceShadowRange[] {
  const out: SurfaceShadowRange[] = [];
  let runId: string | null = null;
  let from = 0;
  let to = 0;
  const flush = () => {
    if (runId !== null) out.push({ from: { runId, seq: from }, to: { runId, seq: to } });
  };
  for (const e of entries) {
    if (runId === null) {
      runId = e.runId;
      from = e.seq;
      to = e.seq;
      continue;
    }
    if (runId === e.runId) {
      to = e.seq;
      continue;
    }
    flush();
    runId = e.runId;
    from = e.seq;
    to = e.seq;
  }
  flush();
  return out;
}
