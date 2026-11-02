import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { startCell, type CellHandle, type CellTool } from "@keel/cell-runtime";
import type { RunRef } from "@keel/core";
import type { CellProcess, IsolationProvider, SpawnSpec } from "../src/isolation.js";
import { CellSupervisor, SupervisedCell, type CellExit } from "../src/supervisor.js";
import { Assembler, type LoadedManifest } from "../src/assembler.js";

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
    this.spawned.push({ handle, process: proc });
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

function rig(toolCallTimeoutMs = 5_000, graceMs = 5_000, pluginPath = "mem://plug") {
  const provider = new FakeProvider();
  const exits: CellExit[] = [];
  const supervisor = new CellSupervisor({
    provider,
    cellEntryPath: "/unused/main.js",
    toolKillGraceMs: graceMs,
    onCellExit: (e) => exits.push(e),
  });
  const cell = supervisor.spawnCell({ manifest: manifest(toolCallTimeoutMs), pluginPath });
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
