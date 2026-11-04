import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";
import { SessionReader } from "../src/session.js";

let dir: string;
let t = 1_000;
let ledger: Ledger;
const ref = { agentId: "agent-a", sessionId: "sess-1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-session-"));
  t = 1_000;
  ledger = new Ledger({ rootDir: dir, now: () => t });
});

afterEach(async () => {
  await ledger.close();
  await rm(dir, { recursive: true, force: true });
});

/** 写一个 run：RUN_STARTED（可带 sessionRun）→ 若干事件 → 可选终态。 */
async function seed(
  runId: string,
  sessionRun: number | undefined,
  terminal: "halted" | "failed" | null,
  body: ("TURN_INPUT" | "DECISION")[] = ["TURN_INPUT"],
): Promise<void> {
  const r = { ...ref, runId };
  await ledger.append(r, "RUN_STARTED", sessionRun === undefined ? {} : { sessionRun });
  for (const type of body) {
    await ledger.append(
      r,
      type,
      type === "TURN_INPUT"
        ? { role: "user", content: `${runId}:${type}` }
        : { round: 1, summary: {}, basedOn: [] },
    );
  }
  if (terminal === "halted") await ledger.append(r, "RUN_HALTED", { reason: "completed" });
  if (terminal === "failed") await ledger.append(r, "RUN_FAILED", { reasonCode: "X" });
}

describe("SessionReader（Phase 5 R3，ADR-0025 复合键）", () => {
  it("顺序：旧账本按 startedAt+runId 在前，编号 run 按 sessionRun 升序", async () => {
    // 故意乱序写入：编号 2 先写、编号 1 后写；旧账本最早
    await seed("run-legacy", undefined, "halted");
    t = 2_000;
    await seed("run-b", 2, null);
    await seed("run-a", 1, "halted");
    const reader = new SessionReader(ledger);
    const runs = await reader.runs(ref);
    expect(runs.map((r) => r.runId)).toEqual(["run-legacy", "run-a", "run-b"]);
    expect(runs.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(runs.map((r) => r.sessionRun)).toEqual([null, 1, 2]);
  });

  it("readRunMeta：终态由最后一条事件判定；未收束 = none", async () => {
    await seed("run-1", 1, "halted");
    await seed("run-2", 2, "failed");
    await seed("run-3", 3, null);
    expect((await ledger.readRunMeta({ ...ref, runId: "run-1" })).terminal).toBe("halted");
    expect((await ledger.readRunMeta({ ...ref, runId: "run-2" })).terminal).toBe("failed");
    expect((await ledger.readRunMeta({ ...ref, runId: "run-3" })).terminal).toBe("none");
  });

  it("跨 run 分页：游标拼接后与全量顺序一致，不重不漏", async () => {
    await seed("run-1", 1, "halted", ["TURN_INPUT", "DECISION", "TURN_INPUT"]);
    await seed("run-2", 2, "halted", ["TURN_INPUT", "DECISION"]);
    const reader = new SessionReader(ledger);
    const all = await reader.read(ref);
    expect(all.nextCursor).toBeNull();
    expect(all.events.map((e) => `${e.runId}:${e.event.seq}`)).toEqual([
      "run-1:1",
      "run-1:2",
      "run-1:3",
      "run-1:4",
      "run-1:5",
      "run-2:1",
      "run-2:2",
      "run-2:3",
      "run-2:4",
    ]);
    // 每页 2 条：逐页拼接应与一次性读取逐字段一致
    const paged: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await reader.read(ref, { limit: 2 }, cursor);
      paged.push(...page.events.map((e) => `${e.runId}:${e.event.seq}`));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(paged).toEqual(all.events.map((e) => `${e.runId}:${e.event.seq}`));
  });

  it("类型过滤跨 run 生效；from 从指定位置开始", async () => {
    await seed("run-1", 1, "halted", ["TURN_INPUT", "DECISION"]);
    await seed("run-2", 2, "halted", ["TURN_INPUT", "DECISION"]);
    const reader = new SessionReader(ledger);
    const onlyTurn = await reader.read(ref, { types: ["TURN_INPUT"] });
    expect(onlyTurn.events).toHaveLength(2);
    expect(onlyTurn.events.every((e) => e.event.type === "TURN_INPUT")).toBe(true);
    const fromRun2 = await reader.read(ref, { from: { run: 2, seq: 2 } });
    expect(fromRun2.events.map((e) => `${e.runId}:${e.event.seq}`)).toEqual([
      "run-2:2",
      "run-2:3",
      "run-2:4",
    ]);
  });

  it("summary：lastRun 与 activeRun（无终态）可见", async () => {
    await seed("run-1", 1, "halted");
    await seed("run-2", 2, null);
    const summary = await new SessionReader(ledger).summary(ref);
    expect(summary.runs).toHaveLength(2);
    expect(summary.lastRunId).toBe("run-2");
    expect(summary.activeRunId).toBe("run-2");
  });

  it("非法游标 = LEDGER/CURSOR-INVALID", async () => {
    await expect(new SessionReader(ledger).read(ref, {}, "not-a-cursor")).rejects.toMatchObject({
      code: "LEDGER/CURSOR-INVALID",
    });
  });
});
