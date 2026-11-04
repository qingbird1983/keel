import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLease } from "../src/session/lease.js";

const ref = { agentId: "agent-a", sessionId: "sess-1" };
let dir: string;
let t = 10_000;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-lease-"));
  t = 10_000;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lease(opts: { isProcessAlive?: (pid: number) => boolean } = {}): SessionLease {
  return new SessionLease({
    rootDir: dir,
    now: () => t,
    ttlMs: 1_000,
    host: "host-1",
    isProcessAlive: opts.isProcessAlive ?? (() => true),
  });
}

describe("SessionLease（Phase 5 R6：同会话单活）", () => {
  it("抢占 → 可见 → 释放 → 可再抢", async () => {
    const l = lease();
    const h = await l.acquire(ref, "run-1");
    expect((await l.peek(ref))?.runId).toBe("run-1");
    await h.release();
    expect(await l.peek(ref)).toBeNull();
    const h2 = await l.acquire(ref, "run-2");
    expect((await l.peek(ref))?.runId).toBe("run-2");
    await h2.release();
  });

  it("并发第二个 run 被拒（SCHED/BACKPRESSURE），持有者不变", async () => {
    const l = lease();
    const h = await l.acquire(ref, "run-1");
    await expect(l.acquire(ref, "run-2")).rejects.toMatchObject({
      code: "SCHED/BACKPRESSURE",
    });
    expect((await l.peek(ref))?.runId).toBe("run-1");
    await h.release();
  });

  it("过期即接管；旧句柄的 release 不删新租约", async () => {
    const l = lease();
    const old = await l.acquire(ref, "run-1");
    t += 2_000; // 过期
    const h2 = await l.acquire(ref, "run-2");
    expect((await l.peek(ref))?.runId).toBe("run-2");
    await old.release(); // 旧句柄：不得删别人的租约
    expect((await l.peek(ref))?.runId).toBe("run-2");
    await h2.release();
  });

  it("同机 pid 已死 = 失效（TTL 未到也可接管）", async () => {
    const alive = lease();
    const h = await alive.acquire(ref, "run-1");
    const dead = lease({ isProcessAlive: () => false });
    const h2 = await dead.acquire(ref, "run-2");
    expect((await dead.peek(ref))?.runId).toBe("run-2");
    await h2.release();
    await h.release();
  });
});
