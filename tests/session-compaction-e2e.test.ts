/**
 * 集成测试（Phase 5 切片④）：压缩是视图操作（锚 E3）。
 *
 * 断言链：摘要调用受治理（`MODEL_INVOKED`/`MODEL_USAGE` 成对、`usageRef` 对得上）→
 * 标记排在本次输入之前 → 投影折叠被遮蔽前缀 → 原始事件全在、`--full` 可还原。
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(".");
const bin = path.join(repoRoot, "apps", "keel", "dist", "main.js");
const profile = "tests/fixtures/profile/session-e2e/profile.yaml";
const ONE = '{"tool":"echo","arguments":{"text":"one"}}';
const TWO = '{"tool":"echo","arguments":{"text":"two"}}';

let dataDir: string;

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, KEEL_SESSION_MODEL_KEY: "sk-test-session-compaction" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function runIn(session: string, input: string, extra: string[] = []) {
  return run([
    "run",
    "--profile",
    profile,
    "--session",
    session,
    "--input",
    input,
    "--data-dir",
    dataDir,
    ...extra,
  ]);
}

function show(session: string, extra: string[] = []) {
  return run(["sessions", "show", "--data-dir", dataDir, "--session", session, ...extra]);
}

interface RawEvent {
  runId: string;
  runOrdinal: number;
  event: { type: string; seq: number; payload: Record<string, unknown> };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "keel-session-compaction-"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("压缩是视图操作（Phase 5 切片④，锚 E3）", () => {
  it("手动压缩：受治理摘要 → 标记先于输入 → 折叠可还原 → 原文永留", () => {
    expect(runIn("cmp", ONE).status).toBe(0);

    // run2 首轮前强制压缩，只保留最近 2 条消息
    const compacted = runIn("cmp", TWO, ["--compact", "--keep-recent", "1"]);
    expect(compacted.status, `${compacted.stdout}\n${compacted.stderr}`).toBe(0);
    expect(compacted.stdout).toContain("compacted:");

    const raw = JSON.parse(show("cmp", ["--raw", "--json"]).stdout) as { events: RawEvent[] };
    const marker = raw.events.find((e) => e.event.type === "SURFACE_COMPACTED");
    expect(marker).toBeDefined();
    const payload = marker!.event.payload as {
      summary: string;
      shadowed: unknown[];
      reason: string;
      usageRef: { reqId: string };
      projectionVersion: number;
    };
    expect(payload.reason).toBe("manual");
    expect(payload.projectionVersion).toBe(2);
    expect(payload.shadowed.length).toBeGreaterThan(0);
    expect(payload.summary).toContain("summary of");

    // 同一次 run 里：RUN_STARTED → 摘要的 MODEL_* → SURFACE_COMPACTED → TURN_INPUT
    const runEvents = raw.events.filter((e) => e.runId === marker!.runId);
    const types = runEvents.map((e) => e.event.type);
    const idx = (t: string) => types.indexOf(t);
    expect(idx("SURFACE_COMPACTED")).toBeGreaterThan(idx("RUN_STARTED"));
    expect(idx("MODEL_INVOKED")).toBeGreaterThan(idx("RUN_STARTED"));
    expect(idx("MODEL_USAGE")).toBeGreaterThan(idx("MODEL_INVOKED"));
    expect(idx("TURN_INPUT")).toBeGreaterThan(idx("SURFACE_COMPACTED"));
    const usage = runEvents.find(
      (e) => e.event.type === "MODEL_USAGE" && e.event.payload.reqId === payload.usageRef.reqId,
    );
    expect(usage).toBeDefined();

    // 折叠视图：run1 的输入与工具结果（"one"）被摘要取代；run2 的（"two"）还在
    const folded = show("cmp");
    expect(folded.status).toBe(0);
    expect(folded.stdout).toContain("summary of");
    expect(folded.stdout).not.toContain("one");
    expect(folded.stdout).toContain("two");

    // 还原：--full 忽略标记，原文全在
    const full = show("cmp", ["--full"]);
    expect(full.status).toBe(0);
    expect(full.stdout).not.toContain("summary of");
    expect(full.stdout).toContain("one");

    // 原始事件永留
    expect(raw.events.some((e) => e.event.type === "TURN_INPUT")).toBe(true);
  }, 240_000);

  it("阈值触发：输入 token 超阈值时自动压缩（同一条链）", () => {
    expect(
      run(["run", "--profile", profile, "--session", "auto", "--input", ONE, "--data-dir", dataDir])
        .status,
    ).toBe(0);
    const auto = run([
      "run",
      "--profile",
      profile,
      "--session",
      "auto",
      "--input",
      TWO,
      "--compact-threshold",
      "1",
      "--keep-recent",
      "2",
      "--data-dir",
      dataDir,
    ]);
    expect(auto.status, `${auto.stdout}\n${auto.stderr}`).toBe(0);
    expect(auto.stdout).toContain("compacted:");
    const folded = show("auto");
    expect(folded.stdout).toContain("summary of");
  }, 240_000);
});
