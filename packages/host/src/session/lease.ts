/**
 * 会话租约（Phase 5 切片②，01 稿 §3.3 / 合同 K3）。
 *
 * 同一会话同时只允许一个 run。租约是会话目录下的一个点文件，用 `O_EXCL` 抢占，
 * 冲突时给出持有者信息；跨进程失效靠 TTL + 同机 pid 存活判定，跨机只有 TTL
 * （单机 MVP，ADR-0002）。
 *
 * 获取必须发生在**任何账本写入与装配之前**——拒绝路径零写入（E6）。
 */

import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { KeelError } from "@keel/core";
import type { SessionRef } from "@keel/core";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionLeaseOptions {
  rootDir: string;
  /** 时间注入（standards/05 §3）。 */
  now?: () => number;
  /** 租约有效期；checkpoint 心跳由调用方续期（本切片不做心跳，TTL 覆盖单次 run）。 */
  ttlMs?: number;
  /** 本机标识（默认 hostname）；跨机只按 TTL 判失效。 */
  host?: string;
  /** pid 存活判定注入位（测试用）。 */
  isProcessAlive?: (pid: number) => boolean;
}

export interface LeaseRecord {
  runId: string;
  pid: number;
  host: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface LeaseHandle {
  ref: SessionRef;
  runId: string;
  record: LeaseRecord;
  release(): Promise<void>;
}

export class SessionLease {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly host: string;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(opts: SessionLeaseOptions) {
    this.rootDir = opts.rootDir;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.host = opts.host ?? hostname();
    this.isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  }

  /** 抢占会话；冲突抛 `SCHED/BACKPRESSURE`（错误码零新增），detail 带持有者。 */
  async acquire(ref: SessionRef, runId: string): Promise<LeaseHandle> {
    assertId("agentId", ref.agentId);
    assertId("sessionId", ref.sessionId);
    assertId("runId", runId);
    const dir = path.join(this.rootDir, ref.agentId, ref.sessionId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, ".lease");
    const record: LeaseRecord = {
      runId,
      pid: process.pid,
      host: this.host,
      acquiredAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        return this.handle(ref, runId, record, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const held = await this.peek(ref);
        if (held && this.isStale(held)) {
          await unlink(file).catch(() => undefined);
          continue; // 接管：再来一次 O_EXCL（并发接管只有一个赢家）
        }
        throw new KeelError("SCHED/BACKPRESSURE", "session is busy", {
          session: { agentId: ref.agentId, sessionId: ref.sessionId },
          heldBy: held ?? "unknown",
        });
      }
    }
    throw new KeelError("SCHED/BACKPRESSURE", "session lease could not be acquired", {
      session: { agentId: ref.agentId, sessionId: ref.sessionId },
    });
  }

  /** 当前持有者（只读；不存在/损坏 = null）。 */
  async peek(ref: SessionRef): Promise<LeaseRecord | null> {
    try {
      const raw = await readFile(
        path.join(this.rootDir, ref.agentId, ref.sessionId, ".lease"),
        "utf8",
      );
      const rec = JSON.parse(raw) as Partial<LeaseRecord>;
      if (typeof rec.runId !== "string" || typeof rec.expiresAt !== "number") return null;
      return rec as LeaseRecord;
    } catch {
      return null;
    }
  }

  /** 失效判定：过期，或同机 pid 已不存活。 */
  isStale(record: LeaseRecord): boolean {
    if (this.now() > record.expiresAt) return true;
    if (record.host !== this.host) return false;
    return !this.isProcessAlive(record.pid);
  }

  private handle(ref: SessionRef, runId: string, record: LeaseRecord, file: string): LeaseHandle {
    return {
      ref,
      runId,
      record,
      release: async () => {
        try {
          const raw = await readFile(file, "utf8");
          const cur = JSON.parse(raw) as { runId?: unknown };
          if (cur.runId !== runId) return; // 已被接管：不要删别人的租约
          await unlink(file);
        } catch {
          /* 已不存在 = 已释放 */
        }
      },
    };
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限发信号（跨用户）：按存活处理，宁可拒绝也不双写
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertId(kind: string, id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new KeelError("SCHED/MANIFEST-INVALID", `invalid ${kind} id`, { [kind]: id });
  }
}
