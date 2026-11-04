/**
 * keel run —— 装配 manifest 并启动一次 demo Run（A1/A2 载体；04 稿 §2）。
 * 薄壳：装配 + 内置 demo driver（调 manifest 声明的工具 N 轮后收束），业务全在 packages/。
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunDriver } from "@keel/core";
import {
  Assembler,
  assembleProfile,
  loadProfile,
  type PolicySpec,
  type ProfileAssembly,
} from "@keel/host";
import {
  assembleManifest,
  buildRuntime,
  closeRuntime,
  loadProfileSchema,
  loadSchema,
  policyCellEntryPath,
  readRun,
  runPolicy,
  runPolicyFor,
  snapshotDirOf,
  wireRun,
} from "./runtime.js";

export interface RunOptions {
  /** manifest JSON 文件路径（与 `profile` 互斥）。 */
  manifest?: string;
  /** 插件 .mjs 路径（Cell 进程加载面；与 `profile` 互斥）。 */
  plugin?: string;
  /** profile.yaml 路径（Phase 4 切片②；与 manifest/plugin 互斥）。 */
  profile?: string;
  /** demo driver 调用的工具名（缺省 ok——tests/fixtures/ok-plugin.mjs 的工具）。 */
  tool?: string;
  /** 轮数（缺省 2：轮 1 调工具，轮 2 收束）。 */
  rounds?: number;
  dataDir?: string;
  /**
   * 快照根目录（切片⑤ §3.2）：缺省由 `--data-dir` 派生同级 `<name>-snapshots`。
   * 只给 `--snapshots` 而不给 `--data-dir` 也行——两者都在临时目录里，随本次运行一起清掉。
   */
  snapshotDir?: string;
  /**
   * 策略插件绑定（切片④ 回填项 ①）：`--policy-manifest` 与 `--policy-module` **按顺序成对**，
   * 可各给多次。两份策略申领同一个插话点 → 装配期整份拒绝（ADR-0012 决策 5）。
   */
  policyManifests?: string[];
  policyModules?: string[];
}

/** @returns 退出码：0 = 终态 halted；1 = 其他终态/异常。 */
export async function cmdRun(opts: RunOptions): Promise<number> {
  // Phase 4 切片②：profile 是另一条装配入口（多插件）；单件路径原样保留（P10）
  if (opts.profile) return runProfile(opts.profile, opts);
  if (!opts.manifest || !opts.plugin) {
    throw new Error("--manifest/--plugin 与 --profile 必居其一（二者互斥）");
  }
  const manifestPath = opts.manifest;
  const pluginPath = opts.plugin;
  const manifest = assembleManifest(JSON.parse(readFileSync(manifestPath, "utf-8")));
  const policySpecs: PolicySpec[] = (opts.policyManifests ?? []).map((file, i) => {
    const modulePath = (opts.policyModules ?? [])[i];
    if (!modulePath) {
      throw new Error(
        `--policy-module missing for policy #${i + 1}（策略必须成对给报关单与模块路径）`,
      );
    }
    return {
      manifest: assembleManifest(JSON.parse(readFileSync(file, "utf-8"))),
      modulePath,
    };
  });
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(tmpdir(), "keel-run-")));
  const snapshotDir = snapshotDirOf(dataDir, opts.snapshotDir);
  const rt = await buildRuntime(dataDir, {
    policy: runPolicy(manifest, "keel-cli"),
    policies: policySpecs,
    snapshotDir,
  });
  try {
    const tool = opts.tool ?? "ok";
    const total = opts.rounds ?? 2;
    const driver: RunDriver = {
      decide: async (c) =>
        c.round < total
          ? { summary: `call ${tool}`, actions: [{ kind: "tool", tool, params: {} }] }
          : { done: true, summary: "demo-end" },
    };
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const run = await wireRun(rt, { runId, driver, manifest, pluginPath });
    const status = await run.done;
    const events = await readRun(rt, runId);
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    console.info(`runId:  ${runId}`);
    console.info(
      `status: ${status.state}${"reasonCode" in status && status.reasonCode ? ` (${status.reasonCode})` : ""}`,
    );
    console.info(
      `events: ${events.length} → ${[...counts].map(([t, n]) => `${t}×${n}`).join(" ")}`,
    );
    if (policySpecs.length > 0) {
      // 交付入口也要看得见"谁被绑上了"（B7① 的账本凭据之外，这行是给复演人的现场证据）
      console.info(
        `hooks:  ${rt.policies.map((b) => `${b.summary.name}@${b.summary.version}→${b.summary.hooks.join("|")}`).join(" ")}`,
      );
    }
    // 快照落盘失败 = "宿主重启后可恢复"这条主张对本次运行不成立：报在明面上，退出码非 0
    // （切片⑤ §3.2 第 4 步。内核的 checkpoint 缝按 Phase 1 的 D3 定案继续"尽力而为"，
    // 可见性的责任在交付入口——不静默跳过，也不为此新增错误码。）
    for (const f of rt.snapshotFailures) {
      console.error(`snapshot-persist: FAILED round=${String(f.round)} (${f.runId}): ${f.message}`);
    }
    if (status.state === "halted" && rt.snapshotFailures.length > 0) {
      console.error(
        "run: halted, but snapshots did not persist — a host restart will not have state to mount",
      );
    }
    return status.state === "halted" && rt.snapshotFailures.length === 0 ? 0 : 1;
  } finally {
    await closeRuntime(rt);
    if (!opts.dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      // 派生的快照目录跟着账本临时目录一起清（不留一堆没人读的内容在临时区）
      if (!opts.snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
    }
  }
}

/**
 * `keel run --profile`（Phase 4 切片②，01 稿 P10）：
 * 一份清单 → 六步装配 → 逐插件记录 → 起 run。
 * engine 驱动的闭环要等 `engine.step`（切片④）；本片对含 engine 的 profile 明确拒绝，
 * 不用 demo driver 假装跑过——"跑了但没经过引擎"比"还没跑"更容易误导。
 */
async function runProfile(profilePath: string, opts: RunOptions): Promise<number> {
  const plan = loadProfile(profilePath, {
    profileSchema: loadProfileSchema(),
    assembler: new Assembler({ schema: loadSchema() }),
  });
  if (plan.plugins.some((p) => p.kind === "engine")) {
    // engine 驱动的闭环要等 `engine.step`（切片④）：在拉任何进程之前就说清楚，
    // 不用 demo driver 假装跑过——"跑了但没经过引擎"比"还没跑"更容易误导。
    throw new Error("engine-driven profile runs land in slice ④ (engine.step 尚未接线)");
  }
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(tmpdir(), "keel-profile-")));
  const snapshotDir = snapshotDirOf(dataDir, opts.snapshotDir);
  const policy = runPolicyFor(
    plan.plugins
      .filter((p) => p.kind === "capability" || p.kind === "engine")
      .map((p) => ({ manifest: p.manifest, subject: p.scope.agentId })),
    "p-profile",
  );
  const rt = await buildRuntime(dataDir, { policy, snapshotDir });
  let assembly: ProfileAssembly | undefined;
  try {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    assembly = await assembleProfile(plan, {
      supervisor: rt.supervisor,
      deps: {
        ledger: rt.ledger,
        auth: rt.auth,
        budget: rt.budget,
        ctx: rt.ctx,
        gateway: rt.gateway,
      },
      runId,
      policy: { bus: rt.hooks, entryPath: policyCellEntryPath },
    });
    const tool = opts.tool ?? "ok";
    const total = opts.rounds ?? 2;
    const driver: RunDriver = {
      decide: async (c) =>
        c.round < total
          ? { summary: `call ${tool}`, actions: [{ kind: "tool", tool, params: {} }] }
          : { done: true, summary: "profile-end" },
    };
    const { done } = rt.scheduler.start({
      ref: assembly.ref,
      subject: assembly.ref.agentId,
      executor: assembly.executor,
      driver,
      assembly: assembly.records,
    });
    for (const c of assembly.cells) c.cell.attachRun(c.ref);
    const binder = assembly.cells[0]?.cell;
    if (binder) rt.bindings.set(assembly.ref.runId, { scope: plan.scope, cell: binder });
    const status = await done;
    const events = await readRun(rt, assembly.ref.runId);
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    console.info(`profile: ${plan.name} (${plan.plugins.length} plugins)`);
    console.info(`runId:   ${assembly.ref.runId}`);
    console.info(
      `status:  ${status.state}${"reasonCode" in status && status.reasonCode ? ` (${status.reasonCode})` : ""}`,
    );
    console.info(
      `events:  ${events.length} → ${[...counts].map(([t, n]) => `${t}×${n}`).join(" ")}`,
    );
    for (const f of rt.snapshotFailures) {
      console.error(`snapshot-persist: FAILED round=${String(f.round)} (${f.runId}): ${f.message}`);
    }
    return status.state === "halted" && rt.snapshotFailures.length === 0 ? 0 : 1;
  } finally {
    if (assembly) await assembly.close();
    rt.bindings.clear();
    await closeRuntime(rt);
    if (!opts.dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      if (!opts.snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
    }
  }
}
