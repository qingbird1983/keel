/**
 * 集成测试（Phase 5 切片③）：崩溃后的会话恢复（锚 E2）。
 *
 * 真进程剧本：工具已执行、第二次模型调用挂住时强杀 CLI 进程 → 下一个 `run --session`
 * 自动走恢复（补偿 → 快照 → 新 run）→ 新 run 的历史截到最后一个一致点、`RUN_RECOVERED`
 * 带 `recoveredFromSeq`；另一个会话照常跑完（故障半径不扩散）。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(".");
const bin = path.join(repoRoot, "apps", "keel", "dist", "main.js");
const profile = "tests/fixtures/profile/session-e2e/profile.yaml";
const PLAN = '{"tool":"echo","arguments":{}}';
/** 第二次模型调用挂 8s：留出"工具已写、还在想"的强杀窗口。 */
const CRASH_PLAN = '{"tool":"echo","arguments":{},"delayMs":8000}';

let dataDir: string;

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, KEEL_SESSION_MODEL_KEY: "sk-test-session-recovery" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function runIn(session: string, input: string) {
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
  ]);
}

function show(session: string, extra: string[] = []) {
  return run(["sessions", "show", "--data-dir", dataDir, "--session", session, ...extra]);
}

/** 轮询等工具结果落账（之后模型调用会挂住，正是强杀窗口）。 */
async function waitForToolResult(session: string, timeoutMs: number): Promise<void> {
  const dir = path.join(dataDir, "session-agent", session);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      for (const runId of readdirSync(dir)) {
        const runDir = path.join(dir, runId);
        if (!statSync(runDir).isDirectory()) continue;
        for (const seg of readdirSync(runDir).filter((n) => n.endsWith(".jsonl"))) {
          if (readFileSync(path.join(runDir, seg), "utf-8").includes('"TOOL_RESULT"')) return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout waiting for TOOL_RESULT to land");
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "keel-session-recovery-"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("崩溃后的会话恢复（Phase 5 切片③，锚 E2）", () => {
  it("强杀 → 自动恢复 → 一致点截断 → RUN_RECOVERED → 并行会话无影响", async () => {
    // 1) 起一个会挂住的 run，等工具结果落账后强杀
    const child = spawn(
      process.execPath,
      [
        bin,
        "run",
        "--profile",
        profile,
        "--session",
        "crash",
        "--input",
        CRASH_PLAN,
        "--data-dir",
        dataDir,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, KEEL_SESSION_MODEL_KEY: "sk-test-session-recovery" },
        stdio: "ignore",
      },
    );
    await waitForToolResult("crash", 30_000);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    // 2) 崩溃 run 没有终态 → 列表里是 unfinished
    const listed = run(["sessions", "list", "--data-dir", dataDir]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("unfinished");

    // 3) 同一会话再来一次 = 自动恢复
    const recovered = runIn("crash", PLAN);
    expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(recovered.stdout).toContain("halted");

    // 4) 新 run 有 RUN_RECOVERED{recoveredFromSeq}，且 sessionRun = 2
    const raw = show("crash", ["--raw"]);
    expect(raw.status).toBe(0);
    expect(raw.stdout).toContain("RUN_RECOVERED");
    const recoveredLine = raw.stdout.split("\n").find((line) => line.includes("RUN_RECOVERED"));
    const recoveredPayload = JSON.parse(recoveredLine!.split(" ").slice(2).join(" ")) as {
      recoveredFromSeq?: number;
    };
    expect(recoveredPayload.recoveredFromSeq).toBeGreaterThan(0);
    expect(raw.stdout).toContain('"sessionRun":2');

    // 5) 历史来自一致点之前：run1 的输入与工具结果都在模型视图里，新 run 看得见
    const view = show("crash");
    expect(view.status).toBe(0);
    expect(view.stdout).toContain(PLAN);
    expect(view.stdout).toContain("status");
    expect(view.stdout).toContain("seen users=2 tools=1");

    // 6) 故障半径：另一个会话照常跑完
    const other = runIn("other", PLAN);
    expect(other.status, `${other.stdout}\n${other.stderr}`).toBe(0);
    expect(other.stdout).toContain("halted");
  }, 240_000);
});
