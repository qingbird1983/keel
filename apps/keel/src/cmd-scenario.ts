/**
 * keel scenario —— A2/A3/A4/A5 一键复演（04 稿 §2/§5）。
 * 装配 tests/fixtures 桩 → 执行 → 断言 = 账本事件存在性检查（不复制包语义）→
 * PASS/FAIL + 证据行（可直接抄进 report.md）。编排与 tests/ 三份集成同构。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunDriver, RunRef, RunStatus } from "@keel/core";
import {
  assembleManifest,
  buildRuntime,
  closeRuntime,
  fixturePath,
  readRun,
  repoRoot,
  snapshotDirOf,
  until,
  wireRun,
  type Runtime,
} from "./runtime.js";
import { listManifestFiles, validateTargets } from "./cmd-validate.js";
import { hotswapDemo } from "./cmd-hotswap.js";

export const SCENARIOS = ["a2", "a3", "a4", "a5"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

interface ScenarioResult {
  pass: boolean;
  lines: string[];
}

const j = (v: unknown): string => JSON.stringify(v);

/** capability 桩 manifest（无越界能力 → 空模板池合法；C-M1 由 templates 声明兜住）。 */
function capManifestRaw(name: string, templates: unknown[]): unknown {
  return {
    kind: "capability",
    meta: { name, version: "1.0.0", title: name, description: `keel scenario ${name}` },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 10_000 },
    compensation: { templates },
    compat: { keelContract: "^1.0" },
  };
}

async function withRuntime<T>(
  tag: string,
  fn: (rt: Runtime, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(path.join(tmpdir(), `keel-${tag}-`));
  const rt = await buildRuntime(dataDir);
  try {
    return await fn(rt, dataDir);
  } finally {
    await closeRuntime(rt);
    await rm(dataDir, { recursive: true, force: true });
    // 派生快照目录跟账本临时目录一起清（A3 会真写快照，切片⑤ §3.2）
    await rm(snapshotDirOf(dataDir), { recursive: true, force: true });
  }
}

/** ── A2：崩溃隔离（V2）── boom 桩在途崩溃 → 仅该 Cell 失败，并行会话不受影响 */
async function scenarioA2(): Promise<ScenarioResult> {
  const lines: string[] = [];
  try {
    return await withRuntime("a2", async (rt) => {
      const boomM = assembleManifest(capManifestRaw("boom-demo", []));
      const okM = assembleManifest(capManifestRaw("ok-demo", []));
      const crashDriver: RunDriver = {
        decide: async (c) =>
          c.round === 1
            ? { summary: "boom", actions: [{ kind: "tool", tool: "boom", params: {} }] }
            : { done: true, summary: "never" },
      };
      const okDriver: RunDriver = {
        decide: async (c) =>
          c.round === 1
            ? { summary: "ok", actions: [{ kind: "tool", tool: "ok", params: {} }] }
            : { done: true, summary: "end" },
      };
      const boom = await wireRun(rt, {
        runId: "run-boom",
        driver: crashDriver,
        manifest: boomM,
        pluginPath: fixturePath("boom-plugin.mjs"),
        scope: { agentId: "keel-a2", sessionId: "sess-boom" },
      });
      const ok = await wireRun(rt, {
        runId: "run-ok",
        driver: okDriver,
        manifest: okM,
        pluginPath: fixturePath("ok-plugin.mjs"),
        scope: { agentId: "keel-a2", sessionId: "sess-ok" },
      });
      const [boomStatus, okStatus] = await Promise.all([boom.done, ok.done]);
      const boomEvs = await readRun(rt, "run-boom");
      const okEvs = await readRun(rt, "run-ok");
      lines.push(
        `boom run: ${boomStatus.state} (${boomStatus.reasonCode ?? "-"}) — expect failed (CELL/CRASH)`,
      );
      lines.push(`ok run:   ${okStatus.state} — expect halted（并行会话不受影响）`);
      const isolated =
        boomEvs.every((e) => e.runId === "run-boom") && okEvs.every((e) => e.runId === "run-ok");
      lines.push(`ledger isolation: boom/ok 事件 runId 无混杂 = ${isolated}`);
      const pass =
        boomStatus.state === "failed" &&
        boomStatus.reasonCode === "CELL/CRASH" &&
        okStatus.state === "halted" &&
        isolated;
      return { pass, lines };
    });
  } catch (err) {
    return {
      pass: false,
      lines: [...lines, `error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/** ── A3：kill 恢复（V3）── 中途 kill → plan 一致点+未决清单 → execute 新 runId 延续 */
async function scenarioA3(): Promise<ScenarioResult> {
  const lines: string[] = [];
  try {
    return await withRuntime("a3", async (rt) => {
      const manifest = assembleManifest(
        capManifestRaw("recover-demo", [
          {
            kind: "recover.ticked",
            class: "record-only",
            action: { type: "plugin", ref: "mark" },
            idempotency: "natural",
          },
        ]),
      );
      const plugin = fixturePath("recover-plugin.mjs");
      const driver1: RunDriver = {
        decide: async (c) =>
          c.round === 1
            ? { summary: "bump", actions: [{ kind: "tool", tool: "bump", params: {} }] }
            : { summary: "slow", actions: [{ kind: "tool", tool: "bump-slow", params: {} }] },
      };
      const first = await wireRun(rt, {
        runId: "a3-run-1",
        driver: driver1,
        manifest,
        pluginPath: plugin,
        scope: { agentId: "keel-a3", sessionId: "sess-a3" },
      });
      await until(async () =>
        (await readRun(rt, "a3-run-1")).some((e) => e.type === "STATE_SNAPSHOT_REF"),
      );
      await until(
        async () =>
          (await readRun(rt, "a3-run-1")).filter((e) => e.type === "EFFECT_DECLARED").length >= 2,
      );
      await first.cell.kill(); // **硬中断**（受控 → killed 分类，ADR-0005）：a3 的前提是"在途被打断"
      const s1 = await first.done;
      const plan = await rt.recovery.plan(first.ref);
      lines.push(
        `kill: ${s1.state} (${s1.reasonCode ?? "-"}); plan: checkpoint round=${String(plan.checkpoint?.round)}（在途轮已收束） pending=${String(plan.pending.length)} snapshot v${String(plan.snapshot?.version)}@round${String(plan.snapshot?.round)}`,
      );
      let continuationTicks = -1;
      const driver2: RunDriver = {
        decide: async (c) => {
          if (c.round === 1) {
            return {
              summary: "resume",
              actions: [{ kind: "tool", tool: "get-state", params: {} }],
            };
          }
          continuationTicks =
            (c.history[0]?.resultDigest as { ticks?: number } | undefined)?.ticks ?? -1;
          return { done: true, summary: "recovered-end" };
        },
      };
      const resumed = await rt.recovery.execute(first.ref, async (_p, mountState) => {
        const run = await wireRun(rt, {
          runId: "a3-run-2",
          driver: driver2,
          manifest,
          pluginPath: plugin,
          scope: { agentId: "keel-a3", sessionId: "sess-a3" },
          mountState,
          recoveredFrom: { runId: "a3-run-1", seq: plan.checkpoint?.seq ?? 0 },
        });
        return { runId: "a3-run-2", done: run.done };
      });
      const status = await resumed.done;
      const newEvs = await readRun(rt, "a3-run-2");
      const recovered = newEvs.find((e) => e.type === "RUN_RECOVERED");
      const executed = (await readRun(rt, "a3-run-1")).filter(
        (e) => e.type === "COMPENSATION_EXECUTED",
      ).length;
      lines.push(
        `execute: new run ${status.state}; RUN_RECOVERED=${recovered ? j(recovered.payload) : "MISSING"}; 挂载快照 ticks=${String(continuationTicks)}; 旧 run 补偿闭环×${String(executed)}`,
      );
      const pass =
        s1.reasonCode === "CELL/KILLED" &&
        plan.checkpoint?.round === 2 &&
        plan.pending.length === 2 &&
        plan.snapshot?.round === 1 &&
        status.state === "halted" &&
        recovered !== undefined &&
        continuationTicks === 1 &&
        executed === 2;
      return { pass, lines };
    });
  } catch (err) {
    return {
      pass: false,
      lines: [...lines, `error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/** ── A4：补偿三路径 + keyed 去重桩（V4）── 失败效果 → cancel 回滚 → 补偿闭环 */
async function scenarioA4(): Promise<ScenarioResult> {
  const lines: string[] = [];
  try {
    const dataDir = await mkdtemp(path.join(tmpdir(), "keel-a4-"));
    const plugin = fixturePath("compensate-plugin.mjs");
    const manifest = assembleManifest(
      capManifestRaw("compensate-demo", [
        {
          kind: "test.undo",
          class: "reversible",
          action: { type: "plugin", ref: "undo" },
          idempotency: "keyed",
        },
        {
          kind: "test.fail",
          class: "reversible",
          action: { type: "plugin", ref: "always-fail" },
          idempotency: "natural",
        },
        {
          kind: "test.record",
          class: "record-only",
          action: { type: "plugin", ref: "mark" },
          idempotency: "natural",
        },
        {
          kind: "test.dedup",
          class: "reversible",
          action: { type: "plugin", ref: "dedup-keyed" },
          idempotency: "keyed",
        },
      ]),
    );
    // P-002：补偿执行器的动作 Cell 材料（factory）必须在构造时在场——manifest 先于 buildRuntime
    const rt = await buildRuntime(dataDir, { actionSpec: { manifest, pluginPath: plugin } });
    try {
      const armRun = async (
        runId: string,
        effectKind: string,
      ): Promise<{ ref: RunRef; done: Promise<RunStatus>; release: () => void }> => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const driver: RunDriver = {
          decide: async (c) => {
            if (c.round === 1) {
              return {
                summary: "arm",
                actions: [{ kind: "tool", tool: "fail-with-effect", params: { effectKind } }],
              };
            }
            await gate;
            return { done: true, summary: "released" };
          },
        };
        const run = await wireRun(rt, {
          runId,
          driver,
          manifest,
          pluginPath: plugin,
          scope: { agentId: "keel-a4", sessionId: `sess-${runId}` },
          withCompensator: true,
        });
        return { ref: run.ref, done: run.done, release };
      };
      const armAndCancel = async (runId: string, effectKind: string) => {
        const { ref, done, release } = await armRun(runId, effectKind);
        await until(async () =>
          (await readRun(rt, ref.runId)).some((e) => e.type === "EFFECT_DECLARED"),
        );
        void rt.scheduler.cancel(ref.runId); // T5：全 Run compensable
        release();
        const status = await done;
        return { ref, status, evs: await readRun(rt, ref.runId) };
      };

      // ① undo 幂等重入
      const p1 = await armAndCancel("a4-undo", "test.undo");
      await until(async () =>
        (await readRun(rt, p1.ref.runId)).some((e) => e.type === "COMPENSATION_EXECUTED"),
      );
      const executed1 = (await readRun(rt, p1.ref.runId)).filter(
        (e) => e.type === "COMPENSATION_EXECUTED",
      );
      const reSweep = await rt.compensator.compensate(p1.ref, { mode: "run" });
      const afterRe = (await readRun(rt, p1.ref.runId)).filter(
        (e) => e.type === "COMPENSATION_EXECUTED",
      ).length;
      lines.push(
        `① undo: ${p1.status.state}; EXECUTED×${String(executed1.length)} digest=${j(executed1[0]?.payload)}; 重扫不重派=${String(reSweep && afterRe === 1)}`,
      );
      const pass1 =
        p1.status.state === "halted" && executed1.length === 1 && reSweep && afterRe === 1;

      // ② 恒败升级
      const p2 = await armAndCancel("a4-escalate", "test.fail");
      const esc = p2.evs.find((e) => e.type === "COMPENSATION_ESCALATED");
      const escalatedAlert = rt.alerts.some((a) => a.runId === p2.ref.runId && a.escalated);
      lines.push(
        `② escalate: ${p2.status.state} (${p2.status.reasonCode ?? "-"}); ESCALATED=${esc ? j(esc.payload) : "MISSING"}; alert=${String(escalatedAlert)}`,
      );
      const pass2 =
        p2.status.state === "failed" &&
        p2.status.reasonCode === "RECOVER/COMPENSATION-FAILED" &&
        esc !== undefined &&
        escalatedAlert;

      // ③ record-only 降级
      const p3 = await armAndCancel("a4-record", "test.record");
      const rec = p3.evs.find((e) => e.type === "COMPENSATION_EXECUTED");
      const recordAlert = rt.alerts.some((a) => a.runId === p3.ref.runId && !a.escalated);
      lines.push(
        `③ record-only: ${p3.status.state}; EXECUTED=${rec ? j(rec.payload) : "MISSING"}; alert=${String(recordAlert)}`,
      );
      const pass3 =
        p3.status.state === "halted" &&
        rec !== undefined &&
        (rec.payload as { resultDigest?: { recordOnly?: boolean } }).resultDigest?.recordOnly ===
          true &&
        recordAlert;

      // ④ keyed 去重桩（重派无害的端到端证明：目标按 effectId 去重）
      const p4 = await armAndCancel("a4-dedup", "test.dedup");
      const dedup = p4.evs.find((e) => e.type === "COMPENSATION_EXECUTED");
      lines.push(
        `④ dedup-keyed: ${p4.status.state}; EXECUTED=${dedup ? j(dedup.payload) : "MISSING"}`,
      );
      const pass4 =
        p4.status.state === "halted" &&
        dedup !== undefined &&
        (dedup.payload as { resultDigest?: { calls?: number } }).resultDigest?.calls === 1;

      const pass = pass1 && pass2 && pass3 && pass4;
      return { pass, lines };
    } finally {
      await closeRuntime(rt);
      await rm(dataDir, { recursive: true, force: true });
    }
  } catch (err) {
    return {
      pass: false,
      lines: [...lines, `error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/** ── A5：结构 + 语义负路径 + V5 热装配回退（validate + hotswap 复用命令主体） */
async function scenarioA5(): Promise<ScenarioResult> {
  const lines: string[] = [];
  const negDir = path.join(repoRoot, "fixtures", "manifest-negative");
  const exDir = path.join(repoRoot, "docs", "design", "phase-1", "schema", "examples");
  const neg = validateTargets(listManifestFiles(negDir));
  const negRejected = neg.filter((r) => !r.ok).length;
  const ex = validateTargets(listManifestFiles(exDir));
  const exAccepted = ex.filter((r) => r.ok).length;
  lines.push(
    `negative group: ${String(negRejected)}/${String(neg.length)} rejected（expect 全拒）; examples: ${String(exAccepted)}/${String(ex.length)} accepted（expect 全过）`,
  );
  const dataDir = await mkdtemp(path.join(tmpdir(), "keel-a5-"));
  try {
    const hs = await hotswapDemo(dataDir);
    lines.push(...hs.lines);
    const pass =
      negRejected === neg.length && exAccepted === ex.length && hs.rollbackOk && hs.switchOk;
    return { pass, lines };
  } catch (err) {
    return {
      pass: false,
      lines: [...lines, `error: ${err instanceof Error ? err.message : String(err)}`],
    };
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** @returns 退出码：0 = PASS；1 = FAIL；2 = 场景名不合法。 */
export async function cmdScenario(name: string): Promise<number> {
  if (!(SCENARIOS as readonly string[]).includes(name)) {
    console.error(`scenario: unknown "${name}" — one of ${SCENARIOS.join("|")}`);
    return 2;
  }
  console.info(`== scenario ${name} ==`);
  const runner: Record<ScenarioName, () => Promise<ScenarioResult>> = {
    a2: scenarioA2,
    a3: scenarioA3,
    a4: scenarioA4,
    a5: scenarioA5,
  };
  const r = await runner[name as ScenarioName]();
  for (const line of r.lines) console.info(`  ${line}`);
  console.info(`scenario ${name}: ${r.pass ? "PASS" : "FAIL"}`);
  return r.pass ? 0 : 1;
}
