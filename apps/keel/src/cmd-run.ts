/**
 * keel run —— 装配 manifest 并启动一次 demo Run（A1/A2 载体；04 稿 §2）。
 * 薄壳：装配 + 内置 demo driver（调 manifest 声明的工具 N 轮后收束），业务全在 packages/。
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SessionReader,
  projectSession,
  type Ledger,
  type RunDriver,
  type SessionEvent,
  type SessionRef,
  type SurfaceMessage,
} from "@keel/core";
import {
  Assembler,
  EngineDriver,
  SessionLease,
  assembleProfile,
  loadProfile,
  projectSessionBudget,
  type LeaseHandle,
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
  /**
   * engine 驱动的 run 起始输入（Phase 4 切片④）：`TURN_INPUT` 的正文。
   * mock 剧本把计划写成 JSON（`{tool, arguments, final}`）；真实模型直接读自然语言。
   */
  input?: string;
  /**
   * 会话 id（Phase 5 切片②）：同一会话的多次 run 共用一条表面投影历史。
   * 缺省保持既有行为（单件 `sess-${runId}`；profile 用清单里的 `scope.sessionId`）。
   */
  session?: string;
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
  let lease: LeaseHandle | undefined;
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
    const sessionRef: SessionRef = {
      agentId: "keel-cli",
      sessionId: opts.session ?? `sess-${runId}`,
    };
    const session = await prepareSession(rt.ledger, dataDir, sessionRef, runId, rt.budget);
    lease = session.lease;
    const run = await wireRun(rt, {
      runId,
      scope: sessionRef,
      driver,
      manifest,
      pluginPath,
      sessionRun: session.sessionRun,
    });
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
    if (lease) await lease.release();
    await closeRuntime(rt);
    if (!opts.dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      // 派生的快照目录跟着账本临时目录一起清（不留一堆没人读的内容在临时区）
      if (!opts.snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
    }
  }
}

interface SessionContext {
  lease: LeaseHandle;
  history: SurfaceMessage[];
  sessionRun: number;
}

/**
 * 会话绑定（Phase 5 切片②）：抢租约（先于任何写与装配）→ 终态检查 → 历史投影 →
 * 会话预算回填 → 下一个运行序号。
 */
async function prepareSession(
  ledger: Ledger,
  dataDir: string,
  ref: SessionRef,
  runId: string,
  budget: { seedSessionUsage(scope: SessionRef, used: number): void },
): Promise<SessionContext> {
  const lease = await new SessionLease({ rootDir: dataDir }).acquire(ref, runId);
  const reader = new SessionReader(ledger);
  try {
    const runs = await reader.runs(ref);
    const last = runs[runs.length - 1];
    if (last && last.terminal === "none") {
      // 崩溃恢复的自动接线归切片③；本片先把"不假装能续"说清楚（不写任何东西）。
      throw new Error(
        `session ${ref.agentId}/${ref.sessionId} has an unfinished run ${last.runId}; ` +
          `run "keel recover --run ${last.runId}" first (auto-recovery lands in slice 3)`,
      );
    }
    const events = await readAllSession(reader, ref);
    budget.seedSessionUsage(ref, projectSessionBudget(events));
    return {
      lease,
      history: projectSession(events),
      sessionRun: runs.reduce((max, r) => Math.max(max, r.sessionRun ?? 0), 0) + 1,
    };
  } catch (err) {
    await lease.release();
    throw err;
  }
}

async function readAllSession(reader: SessionReader, ref: SessionRef): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await reader.read(ref, {}, cursor);
    out.push(...page.events);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

/**
 * `keel run --profile`（Phase 4 切片②/④，01 稿 P10 + 03 稿 E1）：
 * 一份清单 → 六步装配 → 逐插件记录 → 起 run。
 * 含 engine 的 profile 走引擎驱动（每步 `engine.step`，工具仍由 Core 执行）；
 * 不含 engine 的 profile 保留 demo driver（能力型清单的既有入口）。
 */
async function runProfile(profilePath: string, opts: RunOptions): Promise<number> {
  const plan = loadProfile(profilePath, {
    profileSchema: loadProfileSchema(),
    assembler: new Assembler({ schema: loadSchema() }),
    sessionId: opts.session,
  });
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
  let lease: LeaseHandle | undefined;
  try {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const sessionRef: SessionRef = {
      agentId: plan.scope.agentId,
      sessionId: plan.scope.sessionId,
    };
    const session = await prepareSession(rt.ledger, dataDir, sessionRef, runId, rt.budget);
    lease = session.lease;
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
    const driver: RunDriver = assembly.engine
      ? new EngineDriver({
          cell: assembly.engine.cell,
          engine: assembly.engine.decl,
          ledger: rt.ledger,
          ref: assembly.ref,
          history: session.history,
        })
      : {
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
      sessionRun: session.sessionRun,
      // engine 驱动必须有起始输入（表面投影的第一条）；能力型清单保持旧形状。
      ...(assembly.engine
        ? { turnInput: { role: "user" as const, content: opts.input ?? "run the profile" } }
        : {}),
    });
    for (const c of assembly.cells) c.cell.attachRun(c.ref);
    if (assembly.engine) rt.engineCells.add(assembly.engine.cell);
    // 快照索取优先指向 engine（它持有本 run 的循环上下文；能力舱仍各自保留快照面）。
    const binder = assembly.engine?.cell ?? assembly.cells[0]?.cell;
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
    if (lease) await lease.release();
    if (assembly) await assembly.close();
    rt.bindings.clear();
    await closeRuntime(rt);
    if (!opts.dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      if (!opts.snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
    }
  }
}
