/**
 * 会话读取面（Phase 5 R3，ADR-0025 选 A 复合键）。
 *
 * 会话 = `(agentId, sessionId)` 下按 `sessionRun` 排序的 run 序列；事件地址保持
 * `(runId, seq)`——本模块只做"按序拼接 + 复合游标"，不改信封、不改 run 内 seq。
 *
 * 不物化索引文件：顺序与终态都从账本派生（目录布局 + `RUN_STARTED` + 最后一条事件），
 * 账本仍是唯一事实（ADR-0021）。
 */

import { KeelError } from "./errors.js";
import type { EventType, LedgerEvent } from "./events.js";
import { Ledger, type RunMeta } from "./ledger.js";

/** 会话身份 = 信封里已有的两组 id。 */
export interface SessionRef {
  agentId: string;
  sessionId: string;
}

/**
 * 会话流里的一条事件 = 账本事件原样 + 它所属 run 的位置。
 *
 * `runOrdinal` 是**会话流中的位置**（1 起）：新 run 等于 `sessionRun`；旧账本没有
 * `sessionRun`，但同样占一个位置（01 稿 §3.1 兼容规则）。定址仍以 `(runId, seq)` 为准。
 */
export interface SessionEvent {
  runOrdinal: number;
  runId: string;
  sessionRun: number | null;
  event: LedgerEvent;
}

export interface SessionReadFilter {
  types?: EventType[];
  /** 从哪个位置（`runOrdinal`）的哪个 seq 开始（含）。 */
  from?: { run: number; seq: number };
  /** 默认 500，上限 2000。 */
  limit?: number;
}

export interface SessionPage {
  events: SessionEvent[];
  /** 不透明复合游标；透传给下次 read 即可。 */
  nextCursor: string | null;
}

export interface SessionRunInfo extends RunMeta {
  /** 会话流位置（1 起）。 */
  ordinal: number;
}

export interface SessionSummary {
  ref: SessionRef;
  runs: SessionRunInfo[];
  lastRunId: string | null;
  /** 最后一个 run 无终态 = 疑似崩溃（租约是否仍被持有由宿主判定）。 */
  activeRunId: string | null;
}

interface CursorPos {
  /** runs 数组下标。 */
  i: number;
  /** 该 run 内从哪个 seq 开始（含）。 */
  s: number;
}

function encodeCursor(pos: CursorPos): string {
  return Buffer.from(JSON.stringify(pos), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPos {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      i: unknown;
      s: unknown;
    };
    if (
      typeof c.i === "number" &&
      Number.isInteger(c.i) &&
      c.i >= 0 &&
      typeof c.s === "number" &&
      Number.isInteger(c.s) &&
      c.s >= 0
    ) {
      return { i: c.i, s: c.s };
    }
  } catch {
    /* fallthrough */
  }
  throw new KeelError("LEDGER/CURSOR-INVALID", "malformed session cursor", { cursor });
}

/** 旧账本按 `startedAt` 升序、`runId` 兜底；编号 run 按 `sessionRun` 升序，排在旧账本之后。 */
export function orderRuns(metas: readonly RunMeta[]): RunMeta[] {
  const legacy = metas
    .filter((m) => m.sessionRun === null)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.runId.localeCompare(b.runId));
  const numbered = metas
    .filter((m) => m.sessionRun !== null)
    .sort((a, b) => (a.sessionRun ?? 0) - (b.sessionRun ?? 0));
  return [...legacy, ...numbered];
}

export class SessionReader {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /** 有序的 run 列表（只读；单个 run 元信息坏掉时跳过该 run，不让整会话读不出来）。 */
  async runs(ref: SessionRef): Promise<SessionRunInfo[]> {
    const ids = await this.ledger.listRuns(ref.agentId, ref.sessionId);
    const metas: RunMeta[] = [];
    for (const runId of ids) {
      try {
        metas.push(await this.ledger.readRunMeta({ ...ref, runId }));
      } catch {
        /* 目录里没有可读账本 = 不是 run；跳过 */
      }
    }
    return orderRuns(metas).map((m, i) => ({ ...m, ordinal: i + 1 }));
  }

  /** 跨 run 流式读取：按会话顺序拼页，游标是不透明的 `{i, s}`。 */
  async read(
    ref: SessionRef,
    filter: SessionReadFilter = {},
    cursor?: string,
  ): Promise<SessionPage> {
    const runs = await this.runs(ref);
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
    let startIndex = 0;
    let seqFrom = 0;
    if (cursor) {
      const c = decodeCursor(cursor);
      startIndex = c.i;
      seqFrom = c.s;
    } else if (filter.from) {
      const idx = runs.findIndex((r) => r.ordinal === filter.from?.run);
      if (idx < 0) {
        throw new KeelError("LEDGER/CURSOR-INVALID", "unknown session run", {
          run: filter.from.run,
        });
      }
      startIndex = idx;
      seqFrom = filter.from.seq;
    }
    const out: SessionEvent[] = [];
    for (let i = startIndex; i < runs.length; i++) {
      const run = runs[i]!;
      let from = i === startIndex ? seqFrom : 0;
      for (;;) {
        const remaining = limit - out.length;
        if (remaining <= 0) {
          const last = out[out.length - 1]!;
          return { events: out, nextCursor: encodeCursor({ i, s: last.event.seq + 1 }) };
        }
        const page = await this.ledger.read(
          { runId: run.runId, types: filter.types, seqFrom: from },
          undefined,
          remaining,
        );
        for (const ev of page.events) {
          out.push({
            runOrdinal: run.ordinal,
            runId: run.runId,
            sessionRun: run.sessionRun,
            event: ev,
          });
        }
        if (out.length >= limit) {
          const last = out[out.length - 1]!;
          return { events: out, nextCursor: encodeCursor({ i, s: last.event.seq + 1 }) };
        }
        if (!page.nextCursor || page.events.length === 0) break;
        from = page.events[page.events.length - 1]!.seq + 1;
      }
    }
    return { events: out, nextCursor: null };
  }

  /** 会话概览（`keel sessions list`）；`activeRunId` 只按"最后一个 run 无终态"判定。 */
  async summary(ref: SessionRef): Promise<SessionSummary> {
    const runs = await this.runs(ref);
    const last = runs[runs.length - 1] ?? null;
    return {
      ref,
      runs,
      lastRunId: last?.runId ?? null,
      activeRunId: last && last.terminal === "none" ? last.runId : null,
    };
  }
}
