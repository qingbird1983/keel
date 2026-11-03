// keel CLI 命令层冒烟（04 稿 §5 定案 5）：经构建后的 bin 全链验证——
// 内核行为主张不在此重复（归 tests/ 三份集成与各包单测）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(".");
const bin = path.join(repoRoot, "apps", "keel", "dist", "main.js");

function run(args: string[], timeout = 60_000): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    // 非零退出也要看得见 stderr：拒绝类断言（keel <cmd>: <message>）走的是 console.error
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

afterAll(() => {
  // 无持久进程：bin 子进程均自带收束；dist 由 vitest globalSetup 统一构建一次
});

describe("keel CLI（bin 冒烟）", () => {
  it("run --policy-*：策略舱经交付入口接进真实 run（B7① 的 CLI 现场证据）", () => {
    const r = run([
      "run",
      "--manifest",
      "docs/design/phase-1/schema/examples/capability-webfetch.json",
      "--plugin",
      "tests/fixtures/ok-plugin.mjs",
      "--tool",
      "ok",
      "--policy-manifest",
      "docs/design/phase-1/schema/examples/policy-budget-guard.json",
      "--policy-module",
      "tests/fixtures/policies/guard-two-hooks.mjs",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("status: halted");
    // 绑定关系看得见（名字/版本/申领的插话点）——来自装配期起好的策略舱，不是测试自己数的
    expect(r.stdout).toContain("hooks:  budget-guard@0.3.1→toolApproval|budgetExhaustedChoice");
    // 一次工具动作 = 一次 hook① 介入，两条留痕都进了事件计数
    expect(r.stdout).toContain("HOOK_CALLED×1");
    expect(r.stdout).toContain("HOOK_VERDICT×1");
  }, 90_000);

  it("run --policy-*：两份策略抢同一插话点 → 装配期整份拒绝（退出码非 0，不起任何舱）", () => {
    const r = run([
      "run",
      "--manifest",
      "docs/design/phase-1/schema/examples/capability-webfetch.json",
      "--plugin",
      "tests/fixtures/ok-plugin.mjs",
      "--policy-manifest",
      "docs/design/phase-1/schema/examples/policy-budget-guard.json",
      "--policy-module",
      "tests/fixtures/policies/guard-two-hooks.mjs",
      "--policy-manifest",
      "docs/design/phase-1/schema/examples/policy-budget-guard.json",
      "--policy-module",
      "tests/fixtures/policies/deny-transfer.mjs",
    ]);
    expect(r.status).not.toBe(0);
    // 拒绝的话要说清是哪一条插话点被抢（ADR-0012 决策 5）
    expect(`${r.stdout}${r.stderr}`).toContain("two policies claim hook");
    expect(`${r.stdout}${r.stderr}`).not.toContain("runId:");
  }, 90_000);

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

  it("observe：两遍观察 → 候选 + 缺项清单落盘，退出码 = 候选能否过五步校验", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "keel-observe-"));
    try {
      const r = run(
        [
          "observe",
          "--plugin",
          "tests/fixtures/cordis-plugins/tierB-01-no-manifest.cjs",
          "--out",
          out,
        ],
        120_000,
      );
      expect(r.stdout).toContain("validate: ACCEPT");
      expect(r.stdout).toContain("候选不自转正");
      expect(r.status).toBe(0);
      // 两份产物都在盘上，且候选内容 = 观察到的三个名字（不多不少）
      const candidate = JSON.parse(
        readFileSync(path.join(out, "legacy-tierb-01-no-manifest.candidate.json"), "utf-8"),
      ) as { permissions: unknown };
      expect(candidate.permissions).toEqual([
        { cap: "tool.provide", allow: ["gated", "plain", "unlocker"] },
      ]);
      expect(
        readFileSync(path.join(out, "legacy-tierb-01-no-manifest.gaps.md"), "utf-8"),
      ).toContain("UNOBSERVABLE_NATIVE_IO"); // 观察不到的面写在明面上（03 稿 §12 限制 1）
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);
});
