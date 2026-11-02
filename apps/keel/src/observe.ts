/**
 * keel observe —— 观察两遍：为"一张报关单都没有"的旧插件产出**候选**报关单
 * （03 稿 §3/§4；B2 的产品入口）。
 *
 * 支点是 F4：内核拒绝一次越权调用时已经写下完整事实
 * （`AUTH_DENIED{subject × action × resource × policyVersion × reason}`），
 * 所以 pass 1 可以用**什么都不放行**的策略跑——注册面全部以"被拒"的形态读回来，
 * 观察期因此不存在越权窗口（§4 第 1 条）。pass 2 用 pass 1 的候选装配：
 * 放行范围恰好等于观察到的下界，于是每个工具都能被真正调用一次，
 * handler 内部的调用面（第二次 `tool.register`、运行期网络调用……）这才看得见。
 * 两趟证据合并成最终候选；**候选不自转正**（§10 第 2 条）——落盘 + 缺项清单交人工审核。
 *
 * 这里走**显式接线**而不是 `wireCell()`：pass 1 的产物恰恰是"舱在拒绝下崩掉"
 * （旧代码不 await 注册 → 未决拒绝 → 非零退出，02 稿 §6 第三行），
 * ADR-0011 的就绪门在这种趟里不能当装配前置条件。就绪信号改由 driver 的可见表屏障承担：
 * pass 1 等"舱退出"这个证据，pass 2 等"名字到位"这个证据——两者都用既有事实，不新增协议帧。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  type LedgerEvent,
  type RunDriver,
  type RunRef,
  type RunStatus,
  type Scope,
} from "@keel/core";
import {
  EffectTracker,
  serveCellChannel,
  synthesizeManifest,
  synthesizeName,
  type LoadedManifest,
  type SynthesizedCandidate,
} from "@keel/host";
import {
  assembleManifest,
  buildRuntime,
  closeRuntime,
  cordisCellEntryPath,
  runPolicy,
  type Runtime,
} from "./runtime.js";

/** 屏障节奏：子进程起飞实测 <1s，截止只在该红的样本上才会跑到。 */
const BARRIER_POLL_MS = 25;
const BARRIER_DEADLINE_MS = 10_000;
/** 收束余量：崩溃信号 → abort 缝落 RUN_FAILED 是异步的。 */
const SETTLE_MS = 150;

/** 观察趟用的空报关单：未声明 = 无规则 = 当场拒（这是观察手段本身，不是缺陷）。 */
function blankObservationManifest(pluginPath: string, toolCallTimeoutMs: number): LoadedManifest {
  const name = synthesizeName(path.basename(pluginPath));
  return assembleManifest({
    kind: "capability",
    meta: {
      name,
      version: "0.0.0",
      title: name,
      description: `observation manifest for ${name}: declares nothing, so every attempt is denied and recorded`,
    },
    permissions: [],
    resources: { toolCallTimeoutMs },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
  });
}

export interface ObservePluginOptions {
  /** 本次观察的落盘根目录（每趟一个子目录，账本互相不混）。 */
  dataDir: string;
  /** 旧插件文件（.cjs/.mjs 均可，承接层入口装载）。 */
  pluginPath: string;
  /** Cell 入口，缺省 = 承接层入口（`packages/cordis-adapter/dist/cell-entry.js`）。 */
  cellEntry?: string;
  agentId?: string;
  sessionId?: string;
  /** 单次工具调用超时（进候选的 resources.toolCallTimeoutMs，待审项）。 */
  toolCallTimeoutMs?: number;
}

export interface ObservationPass {
  index: number;
  runId: string;
  /** 本趟账本事件 = 观察证据。 */
  events: LedgerEvent[];
  /** 本趟终态（pass 1 正常结局是 failed：被拒 → 舱崩 → RUN_FAILED，可见失败）。 */
  status: RunStatus;
  /** 截至本趟结束累计出的候选（pass 1 = 下界，pass 2 = 合并 handler 内部面）。 */
  candidate: SynthesizedCandidate;
  /** 屏障是否因超时/通道断而放弃（诊断位：负例路径的证据）。 */
  barrierGaveUp: boolean;
}

export interface ObservePluginResult {
  pluginFile: string;
  passes: ObservationPass[];
  /** 两趟证据合并后的最终候选（交人工审核的那份）。 */
  candidate: SynthesizedCandidate;
  /** 最终候选过五步校验的产物；undefined = 没过（CLI 退出码非 0）。 */
  assembled?: LoadedManifest;
  /** 五步校验未过的原因。 */
  assembleError?: string;
  /** 候选 JSON（cmd-observe 落盘用，字节与 `candidate.raw` 一致）。 */
  candidateJson: string;
}

/** 一趟观察的产物：证据（账本事件）+ 终态 + 屏障是否放弃。 */
type PassOutcome = { events: LedgerEvent[]; status: RunStatus; barrierGaveUp: boolean };

interface PassSpec {
  rt: Runtime;
  scope: Scope;
  runId: string;
  subject: string;
  manifest: LoadedManifest;
  pluginPath: string;
  cellEntry: string;
  /** await-crash = pass 1（等"舱崩"这条证据）；cover-tools = pass 2（等名字到位再逐个调用）。 */
  mode: "await-crash" | "cover-tools";
  /** cover-tools 要等到位、随后逐个调用的工具名（= 本趟的下界）。 */
  names: string[];
}

async function drivePass(spec: PassSpec): Promise<PassOutcome> {
  const ref: RunRef = { ...spec.scope, runId: spec.runId };
  const tracker = new EffectTracker({ ledger: spec.rt.ledger });
  const cell = spec.rt.supervisor.spawnCell({
    manifest: spec.manifest,
    pluginPath: spec.pluginPath,
    cellEntry: spec.cellEntry,
    tracker,
  });
  serveCellChannel(
    cell.conn,
    {
      scope: spec.scope,
      ref,
      subject: spec.subject,
      templates: new Map(spec.manifest.templates.map((t) => [t.kind, t])),
    },
    {
      ledger: spec.rt.ledger,
      auth: spec.rt.auth,
      budget: spec.rt.budget,
      ctx: spec.rt.ctx,
      gateway: spec.rt.gateway,
      tracker,
    },
  );
  spec.rt.ctx.alloc(spec.scope);

  let barrier = true;
  let gaveUp = false;
  let waitedMs = 0;
  const queue = spec.mode === "cover-tools" ? [...spec.names] : [];
  const driver: RunDriver = {
    decide: async (c) => {
      const dead = cell.phase === "exited" || cell.conn.isClosed;
      if (barrier) {
        const satisfied =
          spec.mode === "await-crash"
            ? dead
            : spec.names.every((n) => c.tools.some((t) => t.name === n));
        if (satisfied) {
          barrier = false;
          // pass 1 到这就是终点：注册面已经全部以 AUTH_DENIED 落账
          if (spec.mode === "await-crash") {
            await sleep(SETTLE_MS);
            return { done: true, summary: `${spec.runId} denials-observed` };
          }
        } else if (dead || waitedMs >= BARRIER_DEADLINE_MS) {
          gaveUp = true;
          barrier = false;
          if (dead) {
            await sleep(SETTLE_MS);
            return { done: true, summary: `${spec.runId} cell-died-early` };
          }
        } else {
          waitedMs += BARRIER_POLL_MS;
          await sleep(BARRIER_POLL_MS);
          return { summary: `${spec.runId} await-activation`, actions: [] };
        }
      }
      if (dead) {
        // 舱没了还继续调 = 白等超时；收束，让账本自己交代它为什么停了
        return { done: true, summary: `${spec.runId} cell-gone` };
      }
      const tool = queue.shift();
      if (tool !== undefined) {
        return {
          summary: `${spec.runId} cover ${tool}`,
          actions: [{ kind: "tool", tool, params: {} }],
        };
      }
      return { done: true, summary: `${spec.runId} end` };
    },
  };

  const { done } = spec.rt.scheduler.start({
    ref,
    subject: spec.subject,
    executor: cell.executor,
    driver,
    assembly: spec.manifest.record,
  });
  cell.attachRun(ref);
  const status = await done;
  const events = await readEvents(spec.rt, spec.runId);
  await cell.drainAndReap();
  return { events, status, barrierGaveUp: gaveUp };
}

/** 读趟内事件：本 run + 本 scope（观察证据只算这一次装载写出来的）。 */
async function readEvents(rt: Runtime, runId: string): Promise<LedgerEvent[]> {
  try {
    return (await rt.ledger.read({ runId })).events;
  } catch {
    return []; // 舱在首事件之前就死了：一条事实都没有，如实返回空
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function observedNames(candidate: SynthesizedCandidate): string[] {
  return candidate.toolNames;
}

/**
 * 两遍观察的主流程。
 *
 * @returns 每趟的证据与终态、合并后的候选、以及候选过五步校验的结果
 */
export async function observePlugin(o: ObservePluginOptions): Promise<ObservePluginResult> {
  const entry = o.cellEntry ?? cordisCellEntryPath;
  if (!existsSync(entry)) {
    throw new Error(`cordis cell entry missing: ${entry} — run "pnpm build" first`);
  }
  const pluginPath = path.resolve(o.pluginPath);
  const pluginFile = path.basename(pluginPath);
  const agentId = o.agentId ?? "keel-observe";
  const scope: Scope = { agentId, sessionId: o.sessionId ?? `sess-observe` };
  const timeoutMs = o.toolCallTimeoutMs ?? 30_000;
  const tag = synthesizeName(pluginFile).replace(/^legacy-/, "");
  const runIds = { pass1: `observe-${tag}-1`, pass2: `observe-${tag}-2` };

  // ── pass 1：空报关单装配（§4 第 1 条：策略里没有任何 tool.register 规则）────────
  const blank = blankObservationManifest(pluginPath, timeoutMs);
  const rt1 = await buildRuntime(path.join(o.dataDir, "pass-1"), {
    policy: runPolicy(blank, agentId, "p-observe-blank"),
  });
  let p1: PassOutcome;
  let candidate1: SynthesizedCandidate;
  try {
    p1 = await drivePass({
      rt: rt1,
      scope,
      runId: runIds.pass1,
      subject: agentId,
      manifest: blank,
      pluginPath,
      cellEntry: entry,
      mode: "await-crash",
      names: [],
    });
    candidate1 = synthesizeManifest({
      events: p1.events,
      pluginFile,
      observedRunIds: [runIds.pass1],
      defaultToolCallTimeoutMs: timeoutMs,
    });
  } finally {
    await closeRuntime(rt1);
  }

  // ── pass 2：用 pass 1 的候选装配（放行范围 = 观察到的下界）───────────────────
  const granted = assembleManifest(candidate1.raw);
  const rt2 = await buildRuntime(path.join(o.dataDir, "pass-2"), {
    policy: runPolicy(granted, agentId, "p-observe-candidate"),
  });
  let p2: PassOutcome;
  try {
    p2 = await drivePass({
      rt: rt2,
      scope,
      runId: runIds.pass2,
      subject: agentId,
      manifest: granted,
      pluginPath,
      cellEntry: entry,
      mode: "cover-tools",
      names: observedNames(candidate1),
    });
  } finally {
    await closeRuntime(rt2);
  }

  // ── 合并两趟证据 → 最终候选；再过一次五步校验（校验不过 = 不产出可装配的单子）──
  const candidate = synthesizeManifest({
    events: [...p1.events, ...p2.events],
    pluginFile,
    observedRunIds: [runIds.pass1, runIds.pass2],
    defaultToolCallTimeoutMs: timeoutMs,
  });
  let assembled: LoadedManifest | undefined;
  let assembleError: string | undefined;
  try {
    assembled = assembleManifest(candidate.raw);
  } catch (err) {
    assembleError = err instanceof Error ? err.message : String(err);
  }

  const passes: ObservationPass[] = [
    { index: 1, runId: runIds.pass1, ...p1, candidate: candidate1 },
    { index: 2, runId: runIds.pass2, ...p2, candidate },
  ];
  return {
    pluginFile,
    passes,
    candidate,
    assembled,
    assembleError,
    candidateJson: JSON.stringify(candidate.raw, null, 2),
  };
}
