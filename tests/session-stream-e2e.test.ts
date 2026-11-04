/**
 * 集成测试（Phase 5 切片②）：跨 run 会话（锚 E1 / E4 / E6）。
 *
 * 证据链（真进程、两次独立 CLI）：
 * - E1：run2 的模型视图包含 run1 的用户输入 / 模型回答 / 工具结果——夹具模型把看到的
 *   历史条数写进回答，`users=1→2`、`tools=1` 就是"看见了"的机械证据；`sessions show --json`
 *   两次（两个进程）逐字节一致 = 投影可重算。
 * - E4：会话读取按 (agentId, sessionId) 收窄；跨 agent 读取被拒。
 * - E6：同会话已有活租约时，第二个 run 被拒且目标会话目录零 run 写入。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(".");
const bin = path.join(repoRoot, "apps", "keel", "dist", "main.js");
const profile = "tests/fixtures/profile/session-e2e/profile.yaml";
const PLAN = '{"tool":"echo","arguments":{}}';

let dataDir: string;

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, KEEL_SESSION_MODEL_KEY: "sk-test-session-e2e" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function runInSession(session: string): { status: number; stdout: string; stderr: string } {
  return run([
    "run",
    "--profile",
    profile,
    "--session",
    session,
    "--input",
    PLAN,
    "--data-dir",
    dataDir,
  ]);
}

function show(
  session: string,
  extra: string[] = [],
): { status: number; stdout: string; stderr: string } {
  return run(["sessions", "show", "--data-dir", dataDir, "--session", session, ...extra]);
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "keel-session-e2e-"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("跨 run 会话（Phase 5 切片②）", () => {
  it("E1：第二次 run 看见第一次的输入/回答/工具结果；两个进程重算投影一致", () => {
    const r1 = runInSession("s1");
    expect(r1.status, `${r1.stdout}\n${r1.stderr}`).toBe(0);
    expect(r1.stdout).toContain("halted");

    const r2 = runInSession("s1");
    expect(r2.status, `${r2.stdout}\n${r2.stderr}`).toBe(0);

    const view = show("s1");
    expect(view.status, view.stderr).toBe(0);
    // run1 的收尾、run2 的收尾都在模型视图里
    expect(view.stdout).toContain("seen users=1 tools=1");
    expect(view.stdout).toContain("seen users=2 tools=1");

    // 两个独立进程重算：逐字节一致
    const a = show("s1", ["--json"]);
    const b = show("s1", ["--json"]);
    expect(a.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  }, 180_000);

  it("E4：不同会话互不可见；跨 agent 读取被拒（零泄漏）", () => {
    const r = runInSession("s2");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const view = show("s2");
    expect(view.status).toBe(0);
    expect(view.stdout).toContain("seen users=1 tools=1");
    expect(view.stdout).not.toContain("seen users=2");

    const cross = show("s1", ["--agent", "other-agent"]);
    expect(cross.status).not.toBe(0);
    expect(`${cross.stdout}${cross.stderr}`).toContain("not found");
  }, 180_000);

  it("E6：同会话已有活租约 → 第二个 run 被拒且零 run 写入", async () => {
    const dir = path.join(dataDir, "session-agent", "s3");
    await mkdir(dir, { recursive: true });
    writeFileSync(
      path.join(dir, ".lease"),
      JSON.stringify({
        runId: "held-by-another",
        pid: process.pid,
        host: hostname(),
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      }),
    );
    const r = runInSession("s3");
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("session is busy");
    const runs = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("run-")) : [];
    expect(runs).toEqual([]);
  }, 180_000);

  it("sessions list 能看到会话与运行数", () => {
    const r = run(["sessions", "list", "--data-dir", dataDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("session-agent");
    expect(r.stdout).toContain("s1");
    expect(r.stdout).toContain("s2");
  }, 120_000);
});
