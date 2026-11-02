// keel CLI 命令层冒烟（04 稿 §5 定案 5）：经构建后的 bin 全链验证——
// 内核行为主张不在此重复（归 tests/ 三份集成与各包单测）。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(".");
const bin = path.join(repoRoot, "apps", "keel", "dist", "main.js");

function run(args: string[], timeout = 60_000): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "" };
  }
}

beforeAll(() => {
  // CLI bin 与其全部 workspace 依赖的 dist（子进程只能跑 dist）
  execFileSync("pnpm", ["--filter", "keel...", "run", "build"], {
    cwd: repoRoot,
    stdio: "pipe",
    shell: true,
    timeout: 120_000,
  });
});

afterAll(() => {
  // 无持久进程：bin 子进程均自带收束
});

describe("keel CLI（bin 冒烟）", () => {
  it("validate：负路径组全拒（exit 0）", () => {
    const r = run(["validate", "--dir", "fixtures/manifest-negative", "--expect", "reject"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("REJECT");
    expect(r.stdout).toContain("mismatch=0");
  }, 90_000);

  it("replay：决策序列样例可读，归因关键事件在输出中（A6 入口）", () => {
    const r = run([
      "replay",
      "--data-dir",
      "fixtures/ledger/replay-decision-sequence",
      "--run",
      "run-a",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("AUTH_DENIED");
    expect(r.stdout).toContain("HOOK_VERDICT");
    expect(r.stdout).toContain("COMPENSATION_EXECUTED");
  }, 60_000);

  it("run：demo Run 正常收束（halted）", () => {
    const r = run([
      "run",
      "--manifest",
      "docs/design/phase-1/schema/examples/capability-webfetch.json",
      "--plugin",
      "tests/fixtures/ok-plugin.mjs",
      "--tool",
      "ok",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("status: halted");
  }, 90_000);

  it("scenario a2：崩溃隔离一键复演 PASS", () => {
    const r = run(["scenario", "a2"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scenario a2: PASS");
  }, 120_000);

  it("hotswap：V5 回退 + 原子切换 PASS", () => {
    const r = run(["hotswap"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hotswap: PASS");
  }, 90_000);
});
