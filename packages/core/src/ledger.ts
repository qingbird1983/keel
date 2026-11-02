/**
 * 执行账本 —— 契约 §4.4 + ADR-0004。
 *
 * - append-only 分段 JSON 行文件：`<root>/<agentId>/<sessionId>/<runId>/seg-NNNNNN.jsonl`；
 *   段边界对齐一致点（checkpoint 时超限才滚动）。
 * - 轮内事件缓冲追加（filehandle.write，OS 页缓存，读方立即可见）；CHECKPOINT 强制 fsync；
 *   写失败 = fail-stop（LEDGER/WRITE-FAILED），本实例对该 run 拒绝一切后续写。
 * - seq 为 Run 内单调（单写者 = 调度器，ADR-0004）；每个 run 的写任务经串行队列保序。
 * - 跨进程重开已有 run 不受支持（追加序会失真）——恢复/延续一律使用新 runId（契约 §4.5）。
 * - 重放自校验：读遇到损坏行即停止（尾部撕裂语义），最后一条完整 CHECKPOINT 即最近一致点。
 * - 跨 Run 全量读取（观测插件）暂不开放，随观测面落地开放（shortcut: read 仅支持 runId 维度）。
 */

import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { KeelError } from "./errors.js";
import { SCHEMA_VERSION, type EventType, type LedgerEvent, type RunRef } from "./events.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_SEG_MAX_BYTES = 8 * 1024 * 1024;

export interface LedgerOptions {
  rootDir: string;
  /** 时间注入（standards/05 §3）：毫秒纪元。 */
  now?: () => number;
  segMaxBytes?: number;
}

export interface LedgerReadFilter {
  runId: string;
  types?: EventType[];
  seqFrom?: number;
  seqTo?: number;
}

export interface LedgerPage {
  events: LedgerEvent[];
  /** 还有后续数据时非空；透传给下次 read 即可。 */
  nextCursor: string | null;
}

export interface CheckpointInfo {
  seq: number;
  round: number;
}

interface RunWriter {
  ref: RunRef;
  segNo: number;
  opening: Promise<FileHandle>;
  bytes: number;
  lastSeq: number;
  lastCheckpoint: CheckpointInfo | null;
  queue: Promise<unknown>;
  failed: string | null;
}

/** ID 信任边界校验：ID 直接用作路径段，禁止路径穿越字符（standards/04 §2）。 */
export function assertId(kind: string, id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new KeelError("LEDGER/WRITE-FAILED", `invalid ${kind} id`, { id });
  }
}

function segName(segNo: number): string {
  return `seg-${String(segNo).padStart(6, "0")}.jsonl`;
}

function encodeCursor(c: { seg: number; line: number }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { seg: number; line: number } {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      seg: number;
      line: number;
    };
    if (
      typeof c.seg === "number" &&
      Number.isInteger(c.seg) &&
      c.seg >= 1 &&
      typeof c.line === "number" &&
      c.line >= 0
    ) {
      return c;
    }
  } catch {
    /* fallthrough */
  }
  throw new KeelError("LEDGER/CURSOR-INVALID", "malformed cursor", { cursor });
}

export class Ledger {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly segMaxBytes: number;
  private readonly writers = new Map<string, RunWriter>();

  constructor(opts: LedgerOptions) {
    this.rootDir = opts.rootDir;
    this.now = opts.now ?? (() => Date.now());
    this.segMaxBytes = opts.segMaxBytes ?? DEFAULT_SEG_MAX_BYTES;
  }

  /** 追加一条事件（缓冲写；持久性由 checkpoint 保证）。 */
  append(ref: RunRef, type: EventType, payload: unknown): Promise<LedgerEvent> {
    let w: RunWriter;
    try {
      w = this.writer(ref);
    } catch (err) {
      return Promise.reject(err);
    }
    let ev!: LedgerEvent;
    return this.enqueue(w, async (handle) => {
      // seq 在执行期分配：调用序 = 队列序 = 文件内 seq 序（与 checkpoint 的执行期分配保持一致）
      ev = this.makeEvent(ref, w, type, payload);
      const line = `${JSON.stringify(ev)}\n`;
      await handle.write(line, null, "utf8");
      w.bytes += Buffer.byteLength(line, "utf8");
    }).then(() => ev);
  }

  /** 轮边界一致点：fsync 此前全部事件，写入 CHECKPOINT 事件并 fsync（ADR-0004）。 */
  checkpoint(ref: RunRef, round: number): Promise<CheckpointInfo> {
    let w: RunWriter;
    try {
      w = this.writer(ref);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.enqueue(w, async (handle) => {
      await handle.sync();
      const ev = this.makeEvent(ref, w, "CHECKPOINT", { round });
      const line = `${JSON.stringify(ev)}\n`;
      await handle.write(line, null, "utf8");
      w.bytes += Buffer.byteLength(line, "utf8");
      await handle.sync();
      w.lastCheckpoint = { seq: ev.seq, round };
      if (w.bytes >= this.segMaxBytes) await this.rollSegment(w);
      return w.lastCheckpoint;
    });
  }

  /** 最近一致点：优先内存态；冷实例扫描文件（A3 恢复锚）。 */
  async lastCheckpoint(ref: RunRef): Promise<CheckpointInfo | null> {
    const w = this.writers.get(ref.runId);
    if (w) return w.failed ? this.scanCheckpoint(ref) : w.lastCheckpoint;
    return this.scanCheckpoint(ref);
  }

  /** 按 filter + cursor 分批流式读取（契约 ledger.read）。 */
  async read(filter: LedgerReadFilter, cursor?: string, limit = 500): Promise<LedgerPage> {
    assertId("runId", filter.runId);
    const w = this.writers.get(filter.runId);
    const ref = w ? w.ref : await this.scopeOf(filter.runId);
    const pos = cursor ? decodeCursor(cursor) : { seg: 1, line: 0 };
    const types = filter.types ? new Set(filter.types) : null;
    const events: LedgerEvent[] = [];
    for (let seg = pos.seg; ; seg++) {
      let text: string;
      try {
        text = await readFile(path.join(this.runDir(ref), segName(seg)), "utf8");
      } catch {
        return { events, nextCursor: null }; // 段不存在 = 越过末尾
      }
      const lines = text.split("\n");
      let line = seg === pos.seg ? pos.line : 0;
      for (; line < lines.length; line++) {
        const raw = lines[line];
        if (raw === "") continue;
        let ev: LedgerEvent;
        try {
          ev = JSON.parse(raw) as LedgerEvent;
        } catch {
          return { events, nextCursor: null }; // 尾部撕裂：止于最后完整行
        }
        if (!this.matches(ev, filter, types)) continue;
        if (events.length >= limit) return { events, nextCursor: encodeCursor({ seg, line }) };
        events.push(ev);
      }
      if (lines[lines.length - 1] !== "") break; // 末段不以换行结尾 = 撕裂或写入中
    }
    return { events, nextCursor: null };
  }

  /** 关闭全部段文件句柄（standards/04 §3 确定性释放；close 后不得再写）。 */
  async close(): Promise<void> {
    const ws = [...this.writers.values()];
    this.writers.clear();
    await Promise.allSettled(ws.map((w) => w.queue));
    await Promise.allSettled(ws.map((w) => w.opening.then((h) => h.close())));
  }

  /* ── 内部 ─────────────────────────────────────────────────────────── */

  private matches(
    ev: LedgerEvent,
    filter: LedgerReadFilter,
    types: Set<EventType> | null,
  ): boolean {
    if (types && !types.has(ev.type)) return false;
    if (filter.seqFrom !== undefined && ev.seq < filter.seqFrom) return false;
    if (filter.seqTo !== undefined && ev.seq > filter.seqTo) return false;
    return true;
  }

  private async scanCheckpoint(ref: RunRef): Promise<CheckpointInfo | null> {
    let last: CheckpointInfo | null = null;
    let page = await this.read({ runId: ref.runId });
    for (const ev of page.events) {
      if (ev.type === "CHECKPOINT")
        last = { seq: ev.seq, round: (ev.payload as { round: number }).round };
    }
    while (page.nextCursor) {
      page = await this.read({ runId: ref.runId }, page.nextCursor);
      for (const ev of page.events) {
        if (ev.type === "CHECKPOINT")
          last = { seq: ev.seq, round: (ev.payload as { round: number }).round };
      }
    }
    return last;
  }

  private async scopeOf(runId: string): Promise<RunRef> {
    for (const agentId of await safeReaddir(this.rootDir)) {
      for (const sessionId of await safeReaddir(path.join(this.rootDir, agentId))) {
        if ((await safeReaddir(path.join(this.rootDir, agentId, sessionId))).includes(runId)) {
          return { agentId, sessionId, runId };
        }
      }
    }
    throw new KeelError("LEDGER/CURSOR-INVALID", "unknown runId", { runId });
  }

  private runDir(ref: RunRef): string {
    return path.join(this.rootDir, ref.agentId, ref.sessionId, ref.runId);
  }

  private writer(ref: RunRef): RunWriter {
    assertId("agentId", ref.agentId);
    assertId("sessionId", ref.sessionId);
    assertId("runId", ref.runId);
    let w = this.writers.get(ref.runId);
    if (!w) {
      // 追加序保护：已存在账本的 run 不允许新写者实例接笔（见模块注释）
      if (existsSync(path.join(this.runDir(ref), segName(1)))) {
        throw new KeelError(
          "LEDGER/WRITE-FAILED",
          "run ledger already exists in another writer session",
          {
            runId: ref.runId,
          },
        );
      }
      w = {
        ref,
        segNo: 1,
        opening: this.openSegment(ref, 1),
        bytes: 0,
        lastSeq: 0,
        lastCheckpoint: null,
        queue: Promise.resolve(),
        failed: null,
      };
      this.writers.set(ref.runId, w);
    }
    return w;
  }

  private async openSegment(ref: RunRef, segNo: number): Promise<FileHandle> {
    await mkdir(this.runDir(ref), { recursive: true });
    return open(path.join(this.runDir(ref), segName(segNo)), "a");
  }

  private async rollSegment(w: RunWriter): Promise<void> {
    (await w.opening).close();
    w.segNo += 1;
    w.bytes = 0;
    w.opening = this.openSegment(w.ref, w.segNo);
  }

  /** 串行队列：job 按入队顺序执行；任一失败即锁存 fail-stop，后续一律拒绝。 */
  private enqueue<T>(w: RunWriter, job: (handle: FileHandle) => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      if (w.failed) throw new KeelError("LEDGER/WRITE-FAILED", w.failed);
      return job(await w.opening);
    };
    w.queue = w.queue.then(guarded, guarded).catch((err: unknown) => {
      w.failed ??= err instanceof KeelError ? err.message : `write failed: ${String(err)}`;
      throw err instanceof KeelError ? err : new KeelError("LEDGER/WRITE-FAILED", w.failed);
    });
    return w.queue as Promise<T>;
  }

  /** 构造事件（seq 同步分配：调用序 = seq 序 = 写序）。 */
  private makeEvent(ref: RunRef, w: RunWriter, type: EventType, payload: unknown): LedgerEvent {
    const ev: LedgerEvent = {
      seq: w.lastSeq + 1,
      ts: this.now(),
      runId: ref.runId,
      sessionId: ref.sessionId,
      agentId: ref.agentId,
      type,
      schemaVersion: SCHEMA_VERSION,
      payload,
    };
    w.lastSeq = ev.seq;
    return ev;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
