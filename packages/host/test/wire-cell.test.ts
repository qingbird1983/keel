/**
 * 装配收敛点 wireCell（切片②，03 稿 §5；ADR-0011）——四步一次做完，且"等不到就绪"是明确失败。
 *
 * 这里用内存隔离后端（同进程真实 `startCell` + 装载门），为的是把"未就绪"这条路
 * 钉成可确定性观察的断言：真实子进程下未就绪只能靠慢机器偶发命中。
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCell, type CellHandle } from "@keel/cell-runtime";
import {
  Authorizer,
  Budgeter,
  ContextManager,
  KeelError,
  Ledger,
  ModelGateway,
  type RunRef,
  type Scope,
} from "@keel/core";
import type { CellProcess, IsolationProvider, SpawnSpec } from "../src/isolation.js";
import { CellSupervisor } from "../src/supervisor.js";
import { Assembler, type LoadedManifest } from "../src/assembler.js";
import { manifestAuthRules } from "../src/permission-rules.js";
import { CELL_READY_TIMEOUT_MS, wireCell } from "../src/wire-cell.js";
import type { CellServerDeps } from "../src/cell-server.js";

const schema = JSON.parse(
  readFileSync(path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json"), "utf-8"),
);

function manifest(caps = [{ cap: "tool.provide" }]): LoadedManifest {
  return new Assembler({ schema, contractVersion: "1.0.0" }).assemble({
    kind: "capability",
    meta: { name: "wire-plug", version: "1.0.0", title: "W", description: "d" },
    permissions: caps,
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
  });
}

function governedManifest(): LoadedManifest {
  return new Assembler({ schema, contractVersion: "1.0.0" }).assemble({
    kind: "capability",
    meta: { name: "wire-gov", version: "1.0.0", title: "G", description: "d" },
    permissions: [{ cap: "fs.write", allow: ["/tmp/**"] }],
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: {
      templates: [
        {
          kind: "fs.write.done",
          class: "reversible",
          action: { type: "builtin", ref: "fs.remove" },
          idempotency: "natural",
        },
      ],
    },
    compat: { keelContract: "^1.0" },
    governance: {
      tools: [
        {
          name: "write_file",
          guard: { cap: "fs.write", from: "path", prefix: "fs:" },
          effects: [{ kind: "fs.write.done", targetFields: ["path"] }],
        },
      ],
    },
  });
}

/** 内存后端：真实 Cell 进程体 + 装载门；`release(i)` 才开闸（不开 = 永远不应答）。 */
class GatedProvider implements IsolationProvider {
  readonly handles: (CellHandle | null)[] = [];
  readonly procs: Proc[] = [];
  readonly entries: string[] = [];
  readonly boots: Record<string, unknown>[] = [];

  spawn(spec: SpawnSpec): CellProcess {
    const hostToCell = new PassThrough();
    const cellToHost = new PassThrough();
    const boot = JSON.parse(spec.bootstrap) as { toolCallTimeoutMs: number };
    this.boots.push(boot);
    const handle = startCell({
      input: hostToCell,
      output: cellToHost,
      toolCallTimeoutMs: boot.toolCallTimeoutMs,
      loadGate: true,
    });
    const proc = new Proc(cellToHost, hostToCell);
    this.handles.push(handle);
    this.procs.push(proc);
    this.entries.push(spec.entryPath);
    return proc;
  }

  release(i: number): void {
    this.handles[i]?.markReady();
  }

  /** 舱侧客户端（Cell→Core 方向的发起点：注册、下线、发现）。 */
  client(i: number): CellHandle["client"] {
    const h = this.handles[i];
    if (!h) throw new Error("no handle for this spawn (wedged)");
    return h.client;
  }
}

class Proc implements CellProcess {
  killed = false;
  private code: number | null = null;
  private cbs: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  readonly stdin: { write(chunk: string): unknown };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr = null;

  constructor(toHost: PassThrough, fromHost: PassThrough) {
    this.stdin = { write: (c) => fromHost.write(c) };
    this.stdout = toHost;
  }
  kill(): void {
    this.killed = true;
    this.terminate(1);
  }
  alive(): boolean {
    return this.code === null;
  }
  exitCode(): number | null {
    return this.code;
  }
  onExit(cb: (i: { code: number | null; signal: string | null }) => void): void {
    this.cbs.push(cb);
  }
  crash(): void {
    this.terminate(1);
  }
  private terminate(code: number): void {
    if (this.code !== null) return;
    this.code = code;
    for (const cb of this.cbs.splice(0)) cb({ code, signal: null });
    (this.stdout as PassThrough).end();
  }
}

let dir = "";
let ledger!: Ledger;
let supervisor!: CellSupervisor;
let provider!: GatedProvider;
let ctx!: ContextManager;
let deps!: CellServerDeps;
const scope: Scope = { agentId: "agent-w", sessionId: "sess-w" };
const ref: RunRef = { ...scope, runId: "run-w" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-wire-"));
  ledger = new Ledger({ rootDir: dir });
  const m = manifest();
  const auth = new Authorizer(
    { version: "p-wire", allow: manifestAuthRules(m, "agent-w") },
    ledger,
  );
  const budget = new Budgeter(ledger);
  ctx = new ContextManager();
  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
  });
  deps = { ledger, auth, budget, ctx, gateway };
  provider = new GatedProvider();
  supervisor = new CellSupervisor({
    provider,
    cellEntryPath: "/default/main.js",
    toolKillGraceMs: 1_000,
  });
});

afterEach(async () => {
  await ledger.close();
  await rm(dir, { recursive: true, force: true });
});

function params(over: Partial<Parameters<typeof wireCell>[0]> = {}) {
  return {
    supervisor,
    deps,
    scope,
    ref,
    subject: "agent-w",
    manifest: manifest(),
    pluginPath: "mem://plug",
    readyTimeoutMs: 300,
    ...over,
  };
}

describe("wireCell：起舱 → 绑通道 → 建分区 → 探就绪", () => {
  it("就绪后返回可用的舱：分区已建、通道已服务、tracker 就位", async () => {
    const done = wireCell(params());
    provider.release(0);
    const { cell, tracker } = await done;
    expect(cell.phase).toBe("ready");
    expect(ctx.hasScope(scope)).toBe(true);
    expect(tracker.openCount(ref.runId)).toBe(0);
    // 通道真的在服务：从**舱侧客户端**发一次注册，内核按声明编译的规则放行并写分区
    const view = await provider.client(0).registerTool("echo", {});
    expect(view).toEqual({ name: "echo", schemaVersion: 1 });
    expect(ctx.discover(ref).map((t) => t.name)).toEqual(["echo"]);
  });

  it("cellEntry 透传到隔离后端（缺省用 supervisor 的入口）", async () => {
    const a = wireCell(params());
    provider.release(0);
    await a;
    const b = wireCell(params({ cellEntry: "/adapter/dist/cell-entry.js" }));
    provider.release(1);
    await b;
    expect(provider.entries).toEqual(["/default/main.js", "/adapter/dist/cell-entry.js"]);
  });

  it("治理计划随 bootstrap 送达；无声明时载荷形状不变（ADR-0015）", async () => {
    const plain = wireCell(params());
    provider.release(0);
    await plain;
    expect(provider.boots[0]).not.toHaveProperty("governance");

    const governed = wireCell(params({ manifest: governedManifest() }));
    provider.release(1);
    await governed;
    expect(provider.boots[1].governance).toEqual({
      version: 1,
      tools: {
        write_file: {
          guard: { cap: "fs.write", from: "path", prefix: "fs:" },
          effects: [{ kind: "fs.write.done", targetFields: ["path"] }],
        },
      },
    });
  });

  it("门未开（插件没装载完）→ 明确失败，且这个舱被收掉：不静默等下去", async () => {
    const err = (await wireCell(params()).catch((e: unknown) => e)) as KeelError;
    expect(err).toBeInstanceOf(KeelError);
    expect(err.code).toBe("TRANSPORT/TIMEOUT"); // 封闭集合内：探测未得到应答
    expect((err.detail as { reason: string }).reason).toBe("CELL_NOT_READY");
    expect((err.detail as { disposed: boolean }).disposed).toBe(true);
    expect(provider.procs[0].killed).toBe(true); // ADR-0011 决策 3：等不到就 dispose（killed 分类）
    expect(provider.procs[0].alive()).toBe(false);
  });

  it("就绪探测单次不重试：从发出请求到失败的时长 ≈ 给定超时（不会悄悄再问一次）", async () => {
    const t0 = Date.now();
    await expect(wireCell(params({ readyTimeoutMs: 200 }))).rejects.toBeInstanceOf(KeelError);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(600); // 只问一次；重试两次就会超过 400ms 量级
  });

  it("舱在就绪前死掉（通道断）→ 报通道错并同样收掉，不悬挂", async () => {
    const done = wireCell(params({ readyTimeoutMs: 2_000 }));
    provider.procs[0].crash();
    const err = (await done.catch((e: unknown) => e)) as KeelError;
    expect(err.code).toBe("TRANSPORT/BADFRAME");
    expect((err.detail as { reason: string }).reason).toBe("CELL_NOT_READY");
  });

  it("默认超时口径来自契约 §7（5s），不靠调用方各自猜", () => {
    expect(CELL_READY_TIMEOUT_MS).toBe(5_000);
  });

  it("就绪 ≠ 放行：没报关的插件照样装配成功，但一次注册就被拒", async () => {
    // 策略换成"这项能力没报关"编译出来的规则集（空），其余接线不变
    deps.auth = new Authorizer(
      { version: "p-none", allow: manifestAuthRules(manifest([]), "agent-w") },
      ledger,
    );
    const done = wireCell(params({ manifest: manifest([]) }));
    provider.release(0);
    await done; // 就绪探测是只读快照面，不经授权裁决
    await expect(provider.client(0).registerTool("ghost", {})).rejects.toMatchObject({
      code: "AUTH/DENIED",
    });
    expect(ctx.discover(ref)).toEqual([]); // 两半都没写
  });
});
