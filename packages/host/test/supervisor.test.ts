import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCell, type CellHandle, type CellTool } from "@keel/cell-runtime";
import { Ledger, type RunRef } from "@keel/core";
import type { CellProcess, IsolationProvider, SpawnSpec } from "../src/isolation.js";
import { CellSupervisor, SupervisedCell, type CellExit } from "../src/supervisor.js";
import { Assembler, type LoadedManifest } from "../src/assembler.js";
import { EffectTracker } from "../src/effects.js";

let snapDir: string;
beforeEach(async () => {
  snapDir = await mkdtemp(path.join(tmpdir(), "keel-sup-"));
});
afterEach(async () => {
  await rm(snapDir, { recursive: true, force: true });
});

const SCHEMA_PATH = path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

function manifest(toolCallTimeoutMs = 5_000): LoadedManifest {
  return new Assembler({ schema, contractVersion: "1.0.0" }).assemble({
    kind: "capability",
    meta: { name: "plug", version: "1.0.0", title: "P", description: "d" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
  });
}

/**
 * 内存隔离后端：进程体 = 真实 startCell（同进程，经 PassThrough 对）+ 可控退出。
 * pluginPath 以 "wedged:" 前缀标记时不挂真实 Cell（请求永不响应，测强杀路径）。
 */
class FakeProvider implements IsolationProvider {
  readonly spawned: {
    handle: CellHandle | null;
    process: FakeCellProcess;
    /** 实际用于 spawn 的入口（断言 per-spawn 覆盖形状用）。 */
    entryPath: string;
  }[] = [];

  spawn(spec: SpawnSpec): FakeCellProcess {
    const hostToCell = new PassThrough();
    const cellToHost = new PassThrough();
    const boot = JSON.parse(spec.bootstrap) as { pluginPath: string; toolCallTimeoutMs: number };
    let handle: CellHandle | null = null;
    if (!boot.pluginPath.startsWith("wedged:")) {
      handle = startCell({
        input: hostToCell,
        output: cellToHost,
        toolCallTimeoutMs: boot.toolCallTimeoutMs,
      });
    }
    const proc = new FakeCellProcess({ input: cellToHost, output: hostToCell });
    this.spawned.push({ handle, process: proc, entryPath: spec.entryPath });
    return proc;
  }
}

class FakeCellProcess implements CellProcess {
  private exitCbs: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  private exitCodeVal: number | null = null;
  killed = false;
  readonly stdin: { write(chunk: string): unknown };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr = null;

  constructor(io: { input: PassThrough; output: PassThrough }) {
    this.stdin = { write: (c) => io.output.write(c) };
    this.stdout = io.input;
  }

  kill(): void {
    this.killed = true;
    this.terminate(1); // Windows TerminateProcess 形态：非零退出
  }

  alive(): boolean {
    return this.exitCodeVal === null;
  }

  exitCode(): number | null {
    return this.exitCodeVal;
  }

  onExit(cb: (i: { code: number | null; signal: string | null }) => void): void {
    this.exitCbs.push(cb);
  }

  /** 测试驱动：模拟 Cell 崩溃（非 Supervisor 发起）。 */
  crash(code = 1): void {
    this.terminate(code);
  }

  private terminate(code: number | null): void {
    if (this.exitCodeVal !== null) return;
    this.exitCodeVal = code;
    for (const cb of this.exitCbs.splice(0)) cb({ code, signal: null });
    (this.stdout as PassThrough).end();
  }
}

function rig(
  toolCallTimeoutMs = 5_000,
  graceMs = 5_000,
  pluginPath = "mem://plug",
  tracker?: EffectTracker,
) {
  const provider = new FakeProvider();
  const exits: CellExit[] = [];
  const supervisor = new CellSupervisor({
    provider,
    cellEntryPath: "/unused/main.js",
    toolKillGraceMs: graceMs,
    onCellExit: (e) => exits.push(e),
  });
  const cell = supervisor.spawnCell({
    manifest: manifest(toolCallTimeoutMs),
    pluginPath,
    tracker,
  });
  return { supervisor, provider, cell: cell as SupervisedCell, exits };
}

describe("Supervisor：executor 通道绑定（真实 startCell 内存进程）", () => {
  it("tool.exec 结果透传（ok/error/timeout 形不变）", async () => {
    const { provider, cell } = rig();
    const handle = provider.spawned[0].handle!;
    const echo: CellTool = { name: "echo", schema: {}, handler: (p) => ({ echoed: p }) };
    handle.registerTool(echo);
    const r = await cell.executor({ tool: "echo", params: { a: 1 } });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.result).toEqual({ echoed: { a: 1 } });
  });

  it("cell 侧工具超时 → executor 得 timeout 结果（C-D3 硬强制）", async () => {
    const { provider, cell } = rig(100, 5_000); // schema minimum 100ms
    provider.spawned[0].handle!.registerTool({
      name: "wedged",
      schema: {},
      handler: () => new Promise<void>(() => {}),
    });
    const r = await cell.executor({ tool: "wedged", params: null });
    expect(r.status).toBe("timeout");
    if (r.status !== "ok") expect((r.error as { code?: string }).code).toBe("TRANSPORT/TIMEOUT");
  });
});

describe("Supervisor：退出三分类 → onCellExit（契约 §4.1 注记④）", () => {
  it("crash：非 Supervisor 发起的非零退出 → CELL/CRASH", async () => {
    const { provider, cell, exits } = rig();
    const pending = cell.executor({ tool: "any", params: null }); // 在途请求
    provider.spawned[0].process.crash(1);
    const exit = await cell.waitExit();
    expect(exit.exitClass).toBe("crash");
    expect(exit.reasonCode).toBe("CELL/CRASH");
    expect(exits).toHaveLength(1);
    // 在途请求以 error-result 回落（不抛）
    await expect(pending).resolves.toMatchObject({
      status: "error",
      error: { code: "TRANSPORT/BADFRAME" },
    });
  });

  it("clean：exit 0 → CELL/CLEAN-EXIT", async () => {
    const { provider, cell } = rig();
    provider.spawned[0].process.crash(0);
    const exit = await cell.waitExit();
    expect(exit.exitClass).toBe("clean");
    expect(exit.reasonCode).toBe("CELL/CLEAN-EXIT");
  });

  it("killed：Supervisor 强杀 → CELL/KILLED", async () => {
    const { provider, cell } = rig();
    const p = cell.drainAndReap();
    const exit = await cell.waitExit();
    expect(exit.exitClass).toBe("killed");
    expect(exit.reasonCode).toBe("CELL/KILLED");
    expect(provider.spawned[0].process.killed).toBe(true);
    await p;
    expect(cell.phase).toBe("reaped");
  });

  it("失控强杀：wedged cell 超时 + 宽限后 kill（C-D3 后盾）", async () => {
    const { provider, cell, exits } = rig(100, 60, "wedged:plug"); // 100ms 超时 + 60ms 宽限，不挂真实 Cell
    const proc = provider.spawned[0].process;
    const pending = cell.executor({ tool: "x", params: null });
    const exit = await cell.waitExit();
    expect(exit.exitClass).toBe("killed");
    expect(exits[0].reasonCode).toBe("CELL/KILLED");
    await expect(pending).resolves.toMatchObject({
      status: "error",
      error: { code: "TRANSPORT/BADFRAME" },
    });
    expect(proc.killed).toBe(true);
  }, 3_000);
});

describe("Supervisor：生命周期", () => {
  it("attachRun 推进 running；exit 后 exited", () => {
    const { provider, cell } = rig();
    expect(cell.phase).toBe("ready");
    const ref: RunRef = { agentId: "a", sessionId: "s", runId: "r" };
    cell.attachRun(ref);
    expect(cell.phase).toBe("running");
    expect(cell.ref).toBe(ref);
    provider.spawned[0].process.crash(1);
    expect(cell.phase).toBe("exited");
  });
});

describe("Supervisor：效果结算与快照索取（切片④）", () => {
  const ref: RunRef = { agentId: "a", sessionId: "s", runId: "r-1" };

  it("executor ok 结果经 tracker 结算 EFFECT_SETTLED{done}（落点序在 TOOL_RESULT 前）", async () => {
    const ledger = new Ledger({ rootDir: snapDir, now: () => 0 });
    const tracker = new EffectTracker({ ledger });
    tracker.declared(ref, "e-1", []);
    const { provider, cell } = rig(5_000, 5_000, "mem://plug", tracker);
    cell.attachRun(ref);
    provider.spawned[0].handle!.registerTool({
      name: "echo",
      schema: {},
      handler: (p) => ({ echoed: p }),
    });
    expect((await cell.executor({ tool: "echo", params: {} })).status).toBe("ok");
    const evs = (await ledger.read({ runId: "r-1" })).events;
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "EFFECT_SETTLED" });
    expect(evs[0].payload).toEqual({ effectId: "e-1", outcome: "done" });
    await ledger.close();
  });

  it("通道死回落 error-result 也结算 unknown（崩溃残留不入 open 集）", async () => {
    const ledger = new Ledger({ rootDir: snapDir, now: () => 0 });
    const tracker = new EffectTracker({ ledger });
    tracker.declared(ref, "e-2", []);
    const { provider, cell } = rig(5_000, 5_000, "mem://plug", tracker);
    cell.attachRun(ref);
    provider.spawned[0].handle!.registerTool({
      name: "slow",
      schema: {},
      handler: () => new Promise<void>(() => {}), // 在途时进程崩溃
    });
    const pending = cell.executor({ tool: "slow", params: null });
    provider.spawned[0].process.crash(1);
    await expect(pending).resolves.toMatchObject({ status: "error" });
    const evs = (await ledger.read({ runId: "r-1" })).events;
    expect(evs[0]?.payload).toEqual({
      effectId: "e-2",
      outcome: "unknown",
      error: expect.anything(),
    });
    expect(tracker.openCount("r-1")).toBe(0);
    await ledger.close();
  });

  it("pullSnapshot：无快照面 → null；有快照面 → 状态透传", async () => {
    const { provider, cell } = rig();
    await expect(cell.pullSnapshot()).resolves.toBeNull();
    provider.spawned[0].handle!.setSnapshotProvider(() => ({ counters: 3 }));
    await expect(cell.pullSnapshot()).resolves.toEqual({ counters: 3 });
  });
});

describe("Supervisor：per-spawn cellEntry 覆盖（切片① seam，ADR-0010 决策 8）", () => {
  function sup() {
    const provider = new FakeProvider();
    return {
      provider,
      supervisor: new CellSupervisor({ provider, cellEntryPath: "/default/cell-main.js" }),
    };
  }

  it("缺省走 supervisor 的入口；给了 cellEntry 就用它——bootstrap 载荷形状不变", () => {
    const { provider, supervisor } = sup();
    supervisor.spawnCell({ manifest: manifest(), pluginPath: "ok-plugin.mjs" });
    supervisor.spawnCell({
      manifest: manifest(),
      pluginPath: "legacy.cjs",
      cellEntry: "/adapter/dist/cell-entry.js",
    });
    expect(provider.spawned[0].entryPath).toBe("/default/cell-main.js");
    expect(provider.spawned[1].entryPath).toBe("/adapter/dist/cell-entry.js");
    // 入口只决定舱内装载形状，生命周期管理与默认入口完全同源
    expect(provider.spawned[1].handle).not.toBeNull();
  });

  it("同一 supervisor 混装两类插件：入口不同不影响彼此生命周期（崩溃只伤本舱）", async () => {
    const { provider, supervisor } = sup();
    const fresh = supervisor.spawnCell({ manifest: manifest(), pluginPath: "ok-plugin.mjs" });
    const legacy = supervisor.spawnCell({
      manifest: manifest(),
      pluginPath: "legacy.cjs",
      cellEntry: "/adapter/dist/cell-entry.js",
    });
    expect(legacy.phase).toBe("ready");
    provider.spawned[0].process.crash(1);
    expect(fresh.phase).toBe("exited");
    expect(legacy.phase).toBe("ready"); // 换入口不改变隔离语义
  });
});

describe("Supervisor：收尾（drain）的确定次序（切片⑤ §3.3，B7③）", () => {
  it("空舱收尾：拒新 → 无在途 → kill → reaped，产物逐项可核", async () => {
    const { provider, cell } = rig();
    const out = await cell.drainAndReap();
    expect(out).toMatchObject({ inFlightAtStart: 0, settled: 0, timedOut: false, killed: true });
    expect(out.refused).toBe(0); // 此刻还没有人来撞门
    expect(cell.phase).toBe("reaped");
    expect(provider.spawned[0].process.killed).toBe(true);
  });

  it("收尾窗口内的新动作被拒：落成 SCHED/BACKPRESSURE 的 error 结果（不是悄悄打到将死进程）", async () => {
    const { provider, cell } = rig();
    provider.spawned[0].handle!.registerTool({
      name: "slow",
      schema: {},
      handler: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { done: true };
      },
    });
    provider.spawned[0].handle!.registerTool({
      name: "echo",
      schema: {},
      handler: (p) => ({ echoed: p }),
    });
    const inFlight = cell.executor({ tool: "slow", params: null });
    await new Promise((r) => setTimeout(r, 20)); // 让请求真进舱（否则还没 halting）
    const draining = cell.drainAndReap(); // 此刻 phase = halting，进程还活着，正在等在途
    await new Promise((r) => setTimeout(r, 20));
    const refused = await cell.executor({ tool: "echo", params: { a: 1 } });
    expect(refused.status).toBe("error");
    if (refused.status !== "ok")
      expect((refused.error as { code?: string } | undefined)?.code).toBe("SCHED/BACKPRESSURE");
    const out = await draining;
    expect(out.refused).toBe(1); // 拒绝被计入收尾产物（审计看得见"有人在收尾期撞门"）
    expect(out.settled).toBe(1); // 在途那条等到了收束
    await expect(inFlight).resolves.toMatchObject({ status: "ok" });
  });

  it("舱已 reaped 之后的新动作 = 既有口径 TRANSPORT/BADFRAME（进程确实没了，不粉饰成准入拒绝）", async () => {
    const { cell } = rig();
    await cell.drainAndReap();
    const r = await cell.executor({ tool: "echo", params: {} });
    expect(r.status).toBe("error");
    if (r.status !== "ok")
      expect((r.error as { code?: string } | undefined)?.code).toBe("TRANSPORT/BADFRAME");
    // 再收一次是幂等的：已 reaped 的舱不补刀
    const again = await cell.drainAndReap();
    expect(again.killed).toBe(false);
  });

  it("在途动作等到收束：收尾不打断它，结果照常回来（B7③ 的核心主张）", async () => {
    const { provider, cell } = rig();
    provider.spawned[0].handle!.registerTool({
      name: "slow",
      schema: {},
      handler: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { done: true };
      },
    });
    const pending = cell.executor({ tool: "slow", params: null });
    // 让请求真的进到舱里（否则 inFlight 还是 0，测不到等待）
    await new Promise((r) => setTimeout(r, 20));
    const out = await cell.drainAndReap();
    expect(out.inFlightAtStart).toBe(1);
    expect(out.timedOut).toBe(false); // 宽限期没到就已经收束
    expect(out.settled).toBe(1);
    const r = await pending;
    expect(r.status).toBe("ok"); // 没被打断
    if (r.status === "ok") expect(r.result).toEqual({ done: true });
  });

  it("等不到就强杀：宽限期（toolKillGraceMs）到点即 kill，不无限等", async () => {
    // wedged 入口 = 不挂真实 Cell，请求永不响应；grace 给 60ms 让这条测试跑得快
    const { provider, cell } = rig(100, 60, "wedged:plug");
    const never = cell.call("cell.snapshot", {}, 60_000).catch(() => undefined); // 永不落定
    const t0 = Date.now();
    const out = await cell.drainAndReap();
    expect(out.inFlightAtStart).toBe(1);
    expect(out.timedOut).toBe(true); // 硬界生效：是宽限到点，不是收束完成
    expect(out.settled).toBe(0);
    expect(out.killed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000); // 远小于那个 60s 的请求超时
    expect(provider.spawned[0].process.killed).toBe(true);
    await never;
  });
});
