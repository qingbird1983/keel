// keel CLI 命令层冒烟（04 稿 §5 定案 5）：经构建后的 bin 全链验证——
// 内核行为主张不在此重复（归 tests/ 三份集成与各包单测）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  it("validate --profile：满编 profile 只校验不拉起（exit 0）", () => {
    process.env.KEEL_TEST_MODEL_KEY = "sk-test-cli-profile";
    const r = run(["validate", "--profile", "tests/fixtures/profile/all-kinds/profile.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ACCEPT");
    expect(r.stdout).toContain("(5 plugins)");
  }, 60_000);

  it("validate --profile：坏 manifest 混进 profile → REJECT（五步校验零豁免）", () => {
    const r = run(["validate", "--profile", "tests/fixtures/profile/bad-manifest/profile.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("REJECT");
    expect(r.stdout).toContain("SCHED/MANIFEST-INVALID");
  }, 60_000);

  it("run --profile：一份清单拉起 capability 并逐插件落装配记录（D1 的 CLI 入口）", () => {
    const r = run([
      "run",
      "--profile",
      "tests/fixtures/profile/scope-echo/profile.yaml",
      "--tool",
      "echo",
      "--rounds",
      "2",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("profile: scope-echo (1 plugins)");
    expect(r.stdout).toContain("status:  halted");
    expect(r.stdout).toContain("ASSEMBLY_RECORDED×1");
  }, 90_000);

  it("run --profile 与 --manifest 互斥（参数错误退出 2）", () => {
    const r = run([
      "run",
      "--profile",
      "tests/fixtures/profile/scope-echo/profile.yaml",
      "--manifest",
      "docs/design/phase-1/schema/examples/capability-webfetch.json",
      "--plugin",
      "tests/fixtures/ok-plugin.mjs",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("mutually exclusive");
  }, 60_000);

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

  it("run --snapshots：显式目录生效、缺省由账本根派生同级（§3.2 第 5 步）", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "keel-cli-snap-"));
    try {
      const args = (dataDir: string, extra: string[] = []): string[] => [
        "run",
        "--manifest",
        "docs/design/phase-1/schema/examples/capability-webfetch.json",
        "--plugin",
        "tests/fixtures/recover-plugin.mjs",
        "--tool",
        "get-state",
        "--rounds",
        "3",
        "--data-dir",
        dataDir,
        ...extra,
      ];
      // ① 显式给目录：快照落在那里，且**账本根的含义不变**（根下一层只有 agentId）
      const dataDir = path.join(tmp, "ledger");
      const snaps = path.join(tmp, "snaps");
      const r1 = run(args(dataDir, ["--snapshots", snaps]));
      expect(r1.status).toBe(0);
      expect(r1.stdout).toContain("status: halted");
      expect(existsSync(path.join(snaps, "keel-cli"))).toBe(true);
      expect(readdirSync(dataDir)).toEqual(["keel-cli"]);
      // ② 不给 --snapshots：派生同级 `<账本名>-snapshots`，不新增第三个路径概念
      const dataDir2 = path.join(tmp, "ledger2");
      const r2 = run(args(dataDir2));
      expect(r2.status).toBe(0);
      expect(existsSync(path.join(tmp, "ledger2-snapshots", "keel-cli"))).toBe(true);
      // 派生不等于塞回账本根（那会污染两处"根下即 agentId"的扫描：Ledger.scopeOf / cmd-recover.findRunRef）
      expect(readdirSync(dataDir2)).toEqual(["keel-cli"]);
      // 内容确实在盘上（跨宿主恢复的前提；行为主张归 tests/snapshot-cross-host.test.ts）
      const scoped = readdirSync(path.join(snaps, "keel-cli"));
      expect(scoped.length).toBe(1); // 一个 run 一个会话目录
      const files = readdirSync(path.join(snaps, "keel-cli", scoped[0]!)).sort();
      expect(files.every((f) => /^snap-\d+\.json$/.test(f))).toBe(true);
      // 三轮 run（两轮动作 + 一轮收束）留下多份快照：版本号按轮递增，不是每轮覆盖同一份
      expect(files.length).toBeGreaterThanOrEqual(2);
      const file = files[0]!;
      expect(file).toBe("snap-1.json");
      const body = JSON.parse(
        readFileSync(path.join(snaps, "keel-cli", scoped[0]!, file), "utf-8"),
      ) as Record<string, unknown>;
      // 文件形状 = {state, version, round}：版本号与轮次随行，恢复时能核对挂的是哪一份
      expect(body).toEqual({ state: { ticks: 0 }, version: 1, round: 1 });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
