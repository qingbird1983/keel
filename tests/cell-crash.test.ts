/**
 * 集成测试（真实进程）—— 验收 A2 主张（V2，一票否决）的测试化：
 * 注入抛未捕获异常的插件 → 仅该 Cell 失败（RUN_FAILED + CELL/CRASH 原因码），
 * 其他会话不受影响。阶段验收时由 apps/keel CLI 复演。
 *
 * 链路：ProcessIsolationProvider spawn 真实 node 子进程（cell-runtime dist main.js）
 *   → stdio JSON 行帧（契约 §3.1）→ 调度器轮循环 → Supervisor 退出三分类 → abort 缝。
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
  type AuthPolicyInput,
  type LedgerEvent,
  type RunDriver,
  type RunRef,
  type RunStatus,
} from "@keel/core";
import { Assembler, CellSupervisor, ProcessIsolationProvider, serveCellChannel } from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const boomPlugin = path.join(repoRoot, "tests", "fixtures", "boom-plugin.mjs");
const okPlugin = path.join(repoRoot, "tests", "fixtures", "ok-plugin.mjs");
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

const policy: AuthPolicyInput = {
  version: "p1",
  allow: [{ subject: "*", action: "tool.invoke", resource: "*" }],
};

let dir: string;
let ledger: Ledger;
let ctxMgr: ContextManager;
let scheduler: Scheduler;
let supervisor: CellSupervisor;
const ledgers: Ledger[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-a2-"));
  ledger = new Ledger({ rootDir: dir });
  ledgers.push(ledger);
  const auth = new Authorizer(policy, ledger);
  const budget = new Budgeter(ledger);
  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
  });
  ctxMgr = new ContextManager();
  scheduler = new Scheduler({
    ledger,
    auth,
    budget,
    ctx: ctxMgr,
    hooks: new HookBus(ledger),
    gateway,
  });
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

interface WiredRun {
  ref: RunRef;
  done: Promise<RunStatus>;
}

/** 装配一个 scope：Assembler → Supervisor spawn → serveCellChannel → scheduler.start。 */
function wireScope(params: {
  agentId: string;
  sessionId: string;
  runId: string;
  pluginPath: string;
  driver: RunDriver;
}): WiredRun {
  const scope = { agentId: params.agentId, sessionId: params.sessionId };
  const ref: RunRef = { ...scope, runId: params.runId };
  const manifest = new Assembler({ schema: manifestSchema }).assemble({
    kind: "capability",
    meta: { name: "plug", version: "1.0.0", title: "P", description: "a2 fixture" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 60_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
  });
  const cell = supervisor.spawnCell({ manifest, pluginPath: params.pluginPath });
  serveCellChannel(cell.conn, {
    scope,
    ref,
    subject: params.agentId,
    templates: new Map(manifest.templates.map((t) => [t.kind, t])),
  });
  ctxMgr.alloc(scope);
  const { done } = scheduler.start({
    ref,
    subject: params.agentId,
    executor: cell.executor,
    driver: params.driver,
    assembly: manifest.record,
  });
  cell.attachRun(ref);
  return { ref, done };
}

describe("A2（V2）：插件崩溃只失败本 Cell", () => {
  it("崩溃 Cell → RUN_FAILED{CELL/CRASH}；另一会话正常完成、账本互不可见", async () => {
    const driverBoom: RunDriver = {
      decide: async (c) =>
        c.round === 1
          ? { summary: "arm boom", actions: [{ kind: "tool", tool: "boom", params: { n: 1 } }] }
          : { done: true, summary: "end" },
    };
    const driverOk: RunDriver = {
      decide: async (c) =>
        c.round === 1
          ? { summary: "call ok", actions: [{ kind: "tool", tool: "ok", params: { n: 2 } }] }
          : { done: true, summary: "end" },
    };
    const a = wireScope({
      agentId: "agent-a",
      sessionId: "sess-a",
      runId: "run-a",
      pluginPath: boomPlugin,
      driver: driverBoom,
    });
    const b = wireScope({
      agentId: "agent-b",
      sessionId: "sess-b",
      runId: "run-b",
      pluginPath: okPlugin,
      driver: driverOk,
    });

    const [statusA, statusB] = await Promise.all([a.done, b.done]);

    // 崩溃 Cell：仅本 Cell 失败 + crash 原因码（ADR-0005 三分类）
    expect(statusA.state).toBe("failed");
    expect(statusA.reasonCode).toBe("CELL/CRASH");
    // 其他会话不受影响：正常完成
    expect(statusB.state).toBe("halted");

    const read = async (runId: string): Promise<LedgerEvent[]> =>
      (await ledger.read({ runId })).events;
    const evA = await read("run-a");
    const evB = await read("run-b");
    const typesA = evA.map((e) => e.type);
    const typesB = evB.map((e) => e.type);

    // A 账本：装配记录为 run 首事件（切片③注记），RUN_FAILED 带 CELL/CRASH
    expect(typesA[0]).toBe("ASSEMBLY_RECORDED");
    expect(typesA).toContain("RUN_FAILED");
    const failed = evA.find((e) => e.type === "RUN_FAILED");
    expect((failed?.payload as { reasonCode?: string }).reasonCode).toBe("CELL/CRASH");
    // B 账本：无崩溃痕迹，工具成功
    expect(typesB[0]).toBe("ASSEMBLY_RECORDED");
    expect(typesB).not.toContain("RUN_FAILED");
    expect(typesB).toContain("TOOL_RESULT");
    const okTool = evB.find((e) => e.type === "TOOL_RESULT");
    expect((okTool?.payload as { status?: string }).status).toBe("ok");
    // 账本互不可见（I2/I5 结构主张）：各 run 事件 runId 唯一
    expect(new Set(evA.map((e) => e.runId))).toEqual(new Set(["run-a"]));
    expect(new Set(evB.map((e) => e.runId))).toEqual(new Set(["run-b"]));
  }, 20_000);
});
