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
  type ModelUsagePayload,
  type RunDriver,
  type RunRef,
  type RunStatus,
  type SessionEvent,
  type SessionRef,
  type SurfaceMessage,
} from "@keel/core";
import {
  Assembler,
  EngineDriver,
  SessionLease,
  assembleProfile,
  compactSession,
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
  /** 首轮前强制压缩一次（Phase 5 切片④；与阈值自动触发二选一，手动优先）。 */
  compact?: boolean;
  /** 自动压缩阈值：最近一次模型调用的输入 token 数（缺省 128000）。 */
  compactThreshold?: number;
  /** 压缩保留的最近消息条数（缺省 6）。 */
  keepRecent?: number;
  /** 摘要用的模型名（缺省 = 引擎声明的模型）。 */
  summaryModel?: string;
}

const DEFAULT_COMPACT_THRESHOLD = 128_000;

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
    const startRun = (args: {
      recoveredFrom?: { runId: string; seq: number };
      mountState?: unknown;
    }) =>
      wireRun(rt, {
        runId,
        scope: sessionRef,
        driver,
        manifest,
        pluginPath,
        sessionRun: session.sessionRun,
        ...(args.recoveredFrom ? { recoveredFrom: args.recoveredFrom } : {}),
        ...(args.mountState !== undefined ? { mountState: args.mountState } : {}),
      });
    const recovery = session.recovery;
    // 恢复器返回的是收窄的终态（state/reasonCode）；打印面只需要这两项。
    let status: { state: string; reasonCode?: string };
    if (recovery) {
      const resumed = await rt.recovery.execute(
        recovery.oldRef,
        async (recoveryPlan, mountState) => {
          const run = await startRun({
            recoveredFrom: {
              runId: recovery.oldRef.runId,
              seq: recoveryPlan.checkpoint?.seq ?? 0,
            },
            ...(mountState !== undefined && mountState !== null ? { mountState } : {}),
          });
          return { runId, done: run.done };
        },
      );
      status = await resumed.done;
    } else {
      status = await (await startRun({})).done;
    }
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
  events: SessionEvent[];
  history: SurfaceMessage[];
  sessionRun: number;
  /**
   * 最后一个 run 无终态（进程被杀/断电）：调用方走恢复路径（Phase 5 切片③）——
   * 先补偿、再挂快照、再以新 run 接续；历史截到该 run 的最后一个一致点。
   */
  recovery?: { oldRef: RunRef; lastOrdinal: number };
}

/**
 * 会话绑定：抢租约（先于任何写与装配）→ 终态判定 → 历史投影 →
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
    const events = await readAllSession(reader, ref);
    budget.seedSessionUsage(ref, projectSessionBudget(events));
    return {
      lease,
      events,
      history: projectSession(events),
      sessionRun: runs.reduce((max, r) => Math.max(max, r.sessionRun ?? 0), 0) + 1,
      ...(last && last.terminal === "none"
        ? {
            recovery: {
              oldRef: { ...ref, runId: last.runId },
              lastOrdinal: last.ordinal,
            },
          }
        : {}),
    };
  } catch (err) {
    await lease.release();
    throw err;
  }
}

/**
 * 恢复路径的历史（02 稿 §3.1）：**截到崩溃 run 的最后一个一致点**——一致点之后的效果
 * 会被补偿回滚，给模型看会造成"视图与副作用不一致"。没有一致点 = 该 run 一条都不给。
 */
function historyUpToCheckpoint(
  events: readonly SessionEvent[],
  lastOrdinal: number,
  checkpointSeq: number | null,
): SurfaceMessage[] {
  return projectSession(
    events.filter(
      (e) =>
        e.runOrdinal < lastOrdinal ||
        (checkpointSeq !== null && e.runOrdinal === lastOrdinal && e.event.seq <= checkpointSeq),
    ),
  );
}

/** 最近一次模型调用的输入 token 数（压缩阈值的确定性来源）。 */
function sessionInputTokens(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!.event;
    if (ev.type !== "MODEL_USAGE") continue;
    const p = ev.payload as ModelUsagePayload;
    if (p.usageBuckets) return p.usageBuckets.inputCached + p.usageBuckets.inputUncached;
    const usage = p.usage as { prompt_tokens?: unknown } | undefined;
    return typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  }
  return 0;
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
    const tool = opts.tool ?? "ok";
    const total = opts.rounds ?? 2;
    // 阈值取账本里最近一次模型调用的输入桶总量（确定性，不引入分词器依赖，03 稿 §4）
    const shouldCompact =
      opts.compact === true ||
      sessionInputTokens(session.events) >= (opts.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD);
    // 装配 + 起 run 的单一入口：正常续跑与崩溃恢复只在"历史从哪来、要不要 recoveredFrom /
    // mountState"上不同，装配与记账链路必须共用（否则两条路会漂）。
    const startRun = async (args: {
      history: SurfaceMessage[];
      recoveredFrom?: { runId: string; seq: number };
    }): Promise<{ done: Promise<RunStatus> }> => {
      const assembled = await assembleProfile(plan, {
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
      assembly = assembled;
      // 不把快照 blob 挂进引擎舱：engine 无状态（03 稿 E7），对话来自账本投影；
      // 快照仍由 RecoveryManager 校验存在性（缺失即 RECOVER/SNAPSHOT-MISSING），
      // 它是"一致点有状态可续"的凭据，不是本循环的输入。
      const driver: RunDriver = assembled.engine
        ? new EngineDriver({
            cell: assembled.engine.cell,
            engine: assembled.engine.decl,
            ledger: rt.ledger,
            ref: assembled.ref,
            history: args.history,
          })
        : {
            decide: async (c) =>
              c.round < total
                ? { summary: `call ${tool}`, actions: [{ kind: "tool", tool, params: {} }] }
                : { done: true, summary: "profile-end" },
          };
      const engine = assembled.engine;
      const compactBeforeFirstRound =
        engine && shouldCompact
          ? async () => {
              try {
                const payload = await compactSession({
                  ledger: rt.ledger,
                  gateway: rt.gateway,
                  ref: assembled.ref,
                  events: session.events,
                  model: opts.summaryModel ?? engine.decl.model.name,
                  keepRecent: opts.keepRecent,
                  reason: opts.compact === true ? "manual" : "threshold",
                });
                if (payload) {
                  console.info(
                    `compacted: ${payload.shadowed.length} range(s) → ${payload.summary.length} chars`,
                  );
                }
              } catch (err) {
                // 压缩失败不阻断任务（03 稿 §5）：账本只留那次失败的模型调用，视图不变。
                console.error(
                  `compact: skipped (${err instanceof Error ? err.message : String(err)})`,
                );
              }
            }
          : undefined;
      const { done } = rt.scheduler.start({
        ref: assembled.ref,
        subject: assembled.ref.agentId,
        executor: assembled.executor,
        driver,
        assembly: assembled.records,
        sessionRun: session.sessionRun,
        ...(compactBeforeFirstRound ? { beforeFirstRound: compactBeforeFirstRound } : {}),
        ...(args.recoveredFrom ? { recoveredFrom: args.recoveredFrom } : {}),
        // engine 驱动必须有起始输入（表面投影的第一条）；能力型清单保持旧形状。
        ...(assembled.engine
          ? {
              turnInput: {
                role: "user" as const,
                content: opts.input ?? (args.recoveredFrom ? "continue" : "run the profile"),
              },
            }
          : {}),
      });
      for (const c of assembled.cells) c.cell.attachRun(c.ref);
      if (assembled.engine) rt.engineCells.add(assembled.engine.cell);
      // 快照索取优先指向 engine（它持有本 run 的循环上下文；能力舱仍各自保留快照面）。
      const binder = assembled.engine?.cell ?? assembled.cells[0]?.cell;
      if (binder) rt.bindings.set(assembled.ref.runId, { scope: plan.scope, cell: binder });
      return { done };
    };

    const recovery = session.recovery;
    let done: Promise<{ state: string; reasonCode?: string }>;
    if (recovery) {
      // 顺序硬约束（ADR-0004 §4.4 / 02 稿 §3.3）：补偿闭环 → 快照挂载 → 新 run 接续。
      const resumed = await rt.recovery.execute(
        recovery.oldRef,
        async (recoveryPlan, _mountState) => {
          const history = historyUpToCheckpoint(
            session.events,
            recovery.lastOrdinal,
            recoveryPlan.checkpoint?.seq ?? null,
          );
          const started = await startRun({
            history,
            recoveredFrom: {
              runId: recovery.oldRef.runId,
              seq: recoveryPlan.checkpoint?.seq ?? 0,
            },
          });
          return { runId, done: started.done };
        },
      );
      done = resumed.done;
    } else {
      done = (await startRun({ history: session.history })).done;
    }
    const status = await done;
    const events = await readRun(rt, runId);
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    console.info(`profile: ${plan.name} (${plan.plugins.length} plugins)`);
    console.info(`runId:   ${runId}`);
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
