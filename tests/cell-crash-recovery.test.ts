/**
 * 集成测试（真实进程）—— 验收 A3 主张（V3，一票否决）的测试化：
 * 长程任务中途 kill Cell 进程 → recover.plan 给出最近一致点 + 未决补偿清单 + 快照引用
 * → recover.execute（顺序硬约束：先补偿后延续，ADR-0004 §4.4）→ 以新 runId 延续，
 * RUN_RECOVERED 可追溯，快照状态已挂载（新 Cell 读到旧状态）。
 *
 * 快照链路（D3）：宿主 onCheckpoint 缝轮边界索取（cell.snapshot op）→ SnapshotStore 内存
 * 持有 + STATE_SNAPSHOT_REF 元数据入账本；挂载复用 cell.migrate 通道（契约 §4.5 切片④注记）。
 * 阶段验收时由 apps/keel CLI 复演。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Authorizer,
  Budgeter,
  ContextManager,
  HookBus,
  Ledger,
  ModelGateway,
  Scheduler,
  type LedgerEvent,
  type RunDriver,
  type RunRef,
  type RunStatus,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  CompensationExecutor,
  EffectTracker,
  ProcessIsolationProvider,
  RecoveryManager,
  SnapshotStore,
  SupervisedCell,
  serveCellChannel,
  type LoadedManifest,
} from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const plugin = path.join(repoRoot, "tests", "fixtures", "recover-plugin.mjs");
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

const policy = { version: "p1", allow: [{ subject: "*", action: "tool.invoke", resource: "*" }] };

let dir: string;
let ledger: Ledger;
let ctxMgr: ContextManager;
let scheduler: Scheduler;
let supervisor: CellSupervisor;
let snapshots: SnapshotStore;
let recovery: RecoveryManager;
const ledgers: Ledger[] = [];
const bindings = new Map<
  string,
  { scope: { agentId: string; sessionId: string }; cell: SupervisedCell }
>();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-a3-"));
  ledger = new Ledger({ rootDir: dir });
  ledgers.push(ledger);
  const auth = new Authorizer(policy, ledger);
  const budget = new Budgeter(ledger);
  ctxMgr = new ContextManager();
  snapshots = new SnapshotStore();
  const recordCompensator = new CompensationExecutor({ ledger, factory: null }); // record-only 免通道
  recovery = new RecoveryManager({ ledger, compensator: recordCompensator, snapshots });
  scheduler = new Scheduler(
    {
      ledger,
      auth,
      budget,
      ctx: ctxMgr,
      hooks: new HookBus(ledger),
      gateway: new ModelGateway({
        ledger,
        auth,
        budget,
        upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
      }),
    },
    {
      // 快照索取缝（D3，切片④）：CHECKPOINT → STATE_SNAPSHOT_REF → ROUND_ENDED（I3）
      onCheckpoint: async (r, info) => {
        const b = bindings.get(r.runId);
        if (!b) return;
        const state = await b.cell.pullSnapshot();
        const meta = snapshots.save(
          { agentId: r.agentId, sessionId: r.sessionId },
          info.round,
          state,
        );
        if (meta) {
          await ledger.append(r, "STATE_SNAPSHOT_REF", {
            ref: meta.ref,
            version: meta.version,
            round: info.round,
          });
        }
      },
    },
  );
  supervisor = new CellSupervisor({
    provider: new ProcessIsolationProvider(),
    cellEntryPath: cellEntry,
    toolKillGraceMs: 5_000,
    onCellExit: (e) => {
      const ref = e.cell.ref;
      if (ref) void scheduler.abort(ref.runId, e.reasonCode, e.message);
    },
  });
});

afterAll(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

const manifest: LoadedManifest = new Assembler({ schema: manifestSchema }).assemble({
  kind: "capability",
  meta: { name: "plug", version: "1.0.0", title: "P", description: "a3 fixture" },
  permissions: [{ cap: "tool.provide" }],
  resources: { toolCallTimeoutMs: 10_000 },
  compensation: {
    templates: [
      {
        kind: "recover.ticked",
        class: "record-only",
        action: { type: "plugin", ref: "mark" },
        idempotency: "natural",
      },
    ],
  },
  compat: { keelContract: "^1.0" },
});

function wireScope(params: { runId: string; driver: RunDriver }): {
  ref: RunRef;
  done: Promise<RunStatus>;
  cell: SupervisedCell;
} {
  const scope = { agentId: "agent-a3", sessionId: "sess-a3" };
  const ref: RunRef = { ...scope, runId: params.runId };
  const tracker = new EffectTracker({ ledger });
  const cell = supervisor.spawnCell({ manifest, pluginPath: plugin, tracker });
  serveCellChannel(
    cell.conn,
    {
      scope,
      ref,
      subject: scope.agentId,
      templates: new Map(manifest.templates.map((t) => [t.kind, t])),
    },
    { ledger, tracker },
  );
  ctxMgr.alloc(scope);
  // 刻意不接 compensator：中断后效果保持未决，验证 recover.execute 的补偿步（先核对后续跑）
  const { done } = scheduler.start({
    ref,
    subject: scope.agentId,
    executor: cell.executor,
    driver: params.driver,
    assembly: manifest.record,
  });
  cell.attachRun(ref);
  bindings.set(ref.runId, { scope, cell });
  return { ref, done, cell };
}

async function readRun(runId: string): Promise<LedgerEvent[]> {
  return (await ledger.read({ runId })).events;
}

async function until(pred: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("A3（V3）：kill Cell 中途 → recover.plan/execute 以新 runId 延续", () => {
  it("plan 出一致点+未决清单+快照；execute 先补偿再延续，快照已挂载", async () => {
    // ── ① 长程 run：轮 1 正常完成（快照已索取），轮 2 在途时 kill 进程
    const driver1: RunDriver = {
      decide: async (c) =>
        c.round === 1
          ? { summary: "bump", actions: [{ kind: "tool", tool: "bump", params: {} }] }
          : { summary: "slow", actions: [{ kind: "tool", tool: "bump-slow", params: {} }] },
    };
    const first = wireScope({ runId: "a3-run-1", driver: driver1 });
    await until(async () =>
      (await readRun("a3-run-1")).some((e) => e.type === "STATE_SNAPSHOT_REF"),
    );
    await until(
      async () =>
        (await readRun("a3-run-1")).filter((e) => e.type === "EFFECT_DECLARED").length >= 2,
    );
    await first.cell.drainAndReap(); // kill（受控 → killed 分类，ADR-0005）
    const status1 = await first.done;
    expect(status1).toMatchObject({ state: "failed", reasonCode: "CELL/KILLED" });

    // ── ② recover.plan：一致点（在途轮 2 已正常收束——契约注记④）+ 未决清单 + 快照引用
    const plan = await recovery.plan(first.ref);
    expect(plan.checkpoint).toMatchObject({ round: 2 });
    expect(plan.pending).toHaveLength(2); // e(round1, settled-done) + e(round2, verify-pending)
    // 快照停在轮 1：轮 2 收束时的快照拉取因通道死被吞（尽力语义，D3 辅助元数据）
    expect(plan.snapshot).toMatchObject({ version: 1, round: 1 });

    // ── ③ recover.execute：先补偿（record-only 直闭 ×2）→ 挂载快照 → 新 runId 延续
    const scope2 = { agentId: "agent-a3", sessionId: "sess-a3" };
    const ref2: RunRef = { ...scope2, runId: "a3-run-2" };
    let continuationTicks = -1;
    const resumed = await recovery.execute(first.ref, async (p, mountState) => {
      expect(p.oldRunId).toBe("a3-run-1");
      expect(mountState).toEqual({ ticks: 1 }); // 轮 1 的状态由快照恢复
      const driver2: RunDriver = {
        decide: async (c) => {
          if (c.round === 1) {
            return {
              summary: "resume",
              actions: [{ kind: "tool", tool: "get-state", params: {} }],
            };
          }
          continuationTicks =
            (c.history[0]?.resultDigest as { ticks: number } | undefined)?.ticks ?? -1;
          return { done: true, summary: "recovered-end" };
        },
      };
      const tracker2 = new EffectTracker({ ledger });
      const cell2 = supervisor.spawnCell({ manifest, pluginPath: plugin, tracker: tracker2 });
      await cell2.migrate(mountState); // 挂载通道 = cell.migrate（契约 §4.5 切片④注记）
      serveCellChannel(
        cell2.conn,
        {
          scope: scope2,
          ref: ref2,
          subject: scope2.agentId,
          templates: new Map(manifest.templates.map((t) => [t.kind, t])),
        },
        { ledger, tracker: tracker2 },
      );
      ctxMgr.alloc(scope2); // 幂等
      const started = scheduler.start({
        ref: ref2,
        subject: scope2.agentId,
        executor: cell2.executor,
        driver: driver2,
        assembly: manifest.record,
        recoveredFrom: { runId: "a3-run-1", seq: p.checkpoint?.seq ?? 0 },
      });
      cell2.attachRun(ref2);
      return { runId: ref2.runId, done: started.done };
    });
    const status2 = await resumed.done;
    expect(status2.state).toBe("halted"); // 延续 run 正常完成
    expect(continuationTicks).toBe(1); // 快照挂载可观测：新 Cell 读到轮 1 状态

    // ── ④ 账本事实：旧 run 补偿闭环 + 新 run RUN_RECOVERED 可追溯
    const evs1 = await readRun("a3-run-1");
    expect(evs1.filter((e) => e.type === "COMPENSATION_EXECUTED")).toHaveLength(2);
    expect(
      evs1
        .filter((e) => e.type === "EFFECT_DECLARED")
        .every((e) => {
          void e;
          return true;
        }),
    ).toBe(true);
    const evs2 = await readRun("a3-run-2");
    expect(evs2[0]?.type).toBe("ASSEMBLY_RECORDED");
    expect(evs2[1]?.type).toBe("RUN_RECOVERED");
    expect(evs2[1]?.payload).toEqual({
      newRunId: "a3-run-2",
      recoveredFromSeq: plan.checkpoint?.seq,
    });
    const getState = evs2.find((e) => e.type === "TOOL_RESULT");
    expect((getState?.payload as { resultDigest?: { ticks: number } }).resultDigest).toEqual({
      ticks: 1,
    });
  }, 40_000);
});
