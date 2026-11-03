/**
 * 集成测试（真实进程）—— 切片③ AOP + builtin 补偿机制（04/05/06 稿，ADR-0015/0016）。
 *
 * A1：纯 handler 的写文件工具经 manifest governance 自动 guard + EFFECT_DECLARED；
 *     账本序 TOOL_INVOKE → EFFECT_DECLARED → EFFECT_SETTLED → TOOL_RESULT；
 *     随后内置 fs.remove 完成补偿，端到端删掉本次创建的文件（无需插件补偿代码）。
 * A2：guard 拒绝路径——路径不在装配 allow 内，handler 零执行（文件不存在），
 *     内核留 AUTH_DENIED(fs.write)，工具结果为 AUTH/DENIED。
 *
 * 报关单是仓库内真件（tests/fixtures/file-write-plugin/keel-plugin.json）；
 * 唯一测试期替换 = fs.write.allow 的工作区根目录（部署环境量，仓库件给的是范式路径）。
 */

import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type AssemblyRecordedPayload,
  type AuthDeniedPayload,
  type EffectDeclaredPayload,
  type LedgerEvent,
  type RunRef,
  type RunStatus,
  type Scope,
  type ToolResultPayload,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  CompensationExecutor,
  ProcessIsolationProvider,
  manifestAuthRules,
  wireCell,
  type LoadedManifest,
} from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const pluginPath = path.join(repoRoot, "tests", "fixtures", "file-write-plugin", "index.mjs");
const manifestPath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "file-write-plugin",
  "keel-plugin.json",
);
const schemaPath = path.join(
  repoRoot,
  "docs",
  "design",
  "phase-1",
  "schema",
  "keel-plugin.schema.json",
);

let dir: string;
let ledger: Ledger;
let auth: Authorizer;
let budget: Budgeter;
let gateway: ModelGateway;
let ctxMgr: ContextManager;
let scheduler: Scheduler;
let supervisor: CellSupervisor;
let manifest: LoadedManifest;
let allowedRoot: string;
const cells: { drainAndReap(): Promise<unknown> }[] = [];

beforeAll(async () => {
  process.env.KEEL_TEST_SECRET = "should-not-leak";
  dir = await mkdtemp(path.join(tmpdir(), "keel-fw-aop-"));
  allowedRoot = path.join(dir, "workspace").replace(/\\/g, "/");
  await mkdir(allowedRoot, { recursive: true });

  const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    permissions: { cap: string; allow?: string[] }[];
  };
  for (const p of raw.permissions) {
    if (p.cap === "fs.write") p.allow = [`fs:${allowedRoot}/**`];
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  manifest = new Assembler({ schema }).assemble(raw);

  ledger = new Ledger({ rootDir: dir });
  auth = new Authorizer(
    {
      version: "p-aop",
      allow: [
        ...manifestAuthRules(manifest, "agent-a"),
        { subject: "agent-a", action: "tool.invoke", resource: "*" },
      ],
    },
    ledger,
  );
  budget = new Budgeter(ledger);
  ctxMgr = new ContextManager();
  gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
  });
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
      if (!ref) return;
      try {
        void scheduler.abort(ref.runId, e.reasonCode, e.message).catch(() => undefined);
      } catch {
        /* 直连 executor 的测试没有注册 run：退出通知无需 abort */
      }
    },
  });
});

afterAll(async () => {
  delete process.env.KEEL_TEST_SECRET;
  await Promise.allSettled(cells.map((c) => c.drainAndReap()));
  await ledger.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function wire(scope: Scope, runId: string) {
  const ref: RunRef = { ...scope, runId };
  const { cell } = await wireCell({
    supervisor,
    deps: { ledger, auth, budget, ctx: ctxMgr, gateway },
    scope,
    ref,
    subject: scope.agentId,
    manifest,
    pluginPath,
  });
  cells.push(cell);
  return { ref, cell };
}

async function readRun(runId: string): Promise<LedgerEvent[]> {
  return (await ledger.read({ runId })).events;
}

describe("切片③：AOP + builtin 补偿（真实进程）", () => {
  it("A1：纯 handler 自动声明，内置 fs.remove 收尾删文件", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-aop" };
    const { ref, cell } = await wire(scope, "run-aop");
    const target = `${allowedRoot}/hello.txt`;

    const { done } = scheduler.start({
      ref,
      subject: scope.agentId,
      executor: cell.executor,
      driver: {
        decide: async (c) => {
          if (c.round > 1) return { done: true, summary: "aop-end" };
          return {
            summary: "write",
            actions: [
              { kind: "tool", tool: "write_file", params: { path: target, content: "keel" } },
            ],
          };
        },
      },
      assembly: manifest.record,
    });
    cell.attachRun(ref);

    const status = (await done) as RunStatus;
    expect(status.state).toBe("halted");

    // 文件真的写了（业务生效）
    await expect(access(target)).resolves.toBeUndefined();

    const evs = await readRun(ref.runId);
    // 装配记录里权限基线在（builtin fs.remove 的路径复核依据）
    const assembly = evs.find((e) => e.type === "ASSEMBLY_RECORDED");
    expect((assembly?.payload as AssemblyRecordedPayload).permissions).toContainEqual({
      cap: "fs.write",
      allow: [`fs:${allowedRoot}/**`],
    });

    // 账本序：TOOL_INVOKE < EFFECT_DECLARED < EFFECT_SETTLED < TOOL_RESULT
    const idx = (type: string) => evs.findIndex((e) => e.type === type);
    expect(idx("TOOL_INVOKE")).toBeGreaterThanOrEqual(0);
    expect(idx("TOOL_INVOKE")).toBeLessThan(idx("EFFECT_DECLARED"));
    expect(idx("EFFECT_DECLARED")).toBeLessThan(idx("EFFECT_SETTLED"));
    expect(idx("EFFECT_SETTLED")).toBeLessThan(idx("TOOL_RESULT"));

    const declared = evs.find((e) => e.type === "EFFECT_DECLARED");
    const dp = declared?.payload as EffectDeclaredPayload;
    expect(dp).toMatchObject({
      kind: "fs.write.done",
      targetSummary: { path: target },
      compensationClass: "reversible",
      compensation: {
        actionRef: "fs.remove",
        actionType: "builtin",
        idempotency: "natural",
      },
    });
    expect(dp.compensation.paramsDigest).toMatchObject({ alg: "sha256" });

    const result = evs.find((e) => e.type === "TOOL_RESULT")?.payload as ToolResultPayload;
    expect(result.status).toBe("ok");
    expect(result.resultDigest).toEqual({ path: target, bytes: 4 });

    // builtin 补偿：宿主直接删文件，不 spawn 补偿 Cell（factory = null 也不报错）
    const compensator = new CompensationExecutor({ ledger, factory: null });
    expect(await compensator.compensate(ref, { mode: "run" })).toBe(true);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    const executed = (await readRun(ref.runId)).filter((e) => e.type === "COMPENSATION_EXECUTED");
    expect(executed.at(-1)?.payload).toMatchObject({
      resultDigest: { removed: target },
    });
  });

  it("A3：注入 run 失败 → 调度器触发补偿，builtin fs.remove 自动删文件（B8）", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-fail" };
    const { ref, cell } = await wire(scope, "run-fail");
    const target = `${allowedRoot}/failure.txt`;
    const compensator = new CompensationExecutor({ ledger, factory: null });

    const { done } = scheduler.start({
      ref,
      subject: scope.agentId,
      executor: cell.executor,
      driver: {
        decide: async (c) => {
          if (c.round > 1) throw new Error("injected failure after side effect");
          return {
            summary: "write",
            actions: [
              { kind: "tool", tool: "write_file", params: { path: target, content: "undo me" } },
            ],
          };
        },
      },
      assembly: manifest.record,
      compensator: (mode) => compensator.compensate(ref, { mode }),
    });
    cell.attachRun(ref);

    const status = (await done) as RunStatus;
    expect(status.state).toBe("failed");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    const evs = await readRun(ref.runId);
    expect(evs.some((e) => e.type === "RUN_FAILED")).toBe(true);
    expect(evs.filter((e) => e.type === "COMPENSATION_EXECUTED")).toHaveLength(1);
    expect(evs.find((e) => e.type === "COMPENSATION_EXECUTED")?.payload).toMatchObject({
      resultDigest: { removed: target },
    });
  });

  it("A2：guard 拒绝 → handler 零执行、文件不存在、AUTH_DENIED 留痕", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-deny" };
    const { ref, cell } = await wire(scope, "run-deny");
    const outside = path.join(dir, "outside.txt").replace(/\\/g, "/");

    const { done } = scheduler.start({
      ref,
      subject: scope.agentId,
      executor: cell.executor,
      driver: {
        decide: async (c) => {
          if (c.round > 1) return { done: true, summary: "deny-end" };
          return {
            summary: "denied",
            actions: [
              { kind: "tool", tool: "write_file", params: { path: outside, content: "nope" } },
            ],
          };
        },
      },
      assembly: manifest.record,
    });
    cell.attachRun(ref);

    const status = (await done) as RunStatus;
    expect(status.state).toBe("halted"); // 动作级拒绝不改变 run 收束语义

    await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
    const evs = await readRun(ref.runId);
    const denied = evs.filter((e) => e.type === "AUTH_DENIED");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toMatchObject({
      subject: "agent-a",
      action: "fs.write",
      resource: `fs:${outside}`,
    });
    expect(evs.some((e) => e.type === "EFFECT_DECLARED")).toBe(false);
    const result = evs.find((e) => e.type === "TOOL_RESULT")?.payload as ToolResultPayload;
    expect(result.status).toBe("error");
    expect((result.error as { code?: string })?.code).toBe("AUTH/DENIED");
    expect((denied[0]?.payload as AuthDeniedPayload).policyVersion).toBe("p-aop");
  });
});

describe("R3：效果收据与受治理 Workspace（ADR-0018）", () => {
  async function runTool(
    scope: Scope,
    runId: string,
    tool: string,
    params: Record<string, unknown>,
    compensator?: CompensationExecutor,
  ) {
    const { ref, cell } = await wire(scope, runId);
    const { done } = scheduler.start({
      ref,
      subject: scope.agentId,
      executor: cell.executor,
      driver: {
        decide: async (c) =>
          c.round > 1
            ? { done: true, summary: "r3-end" }
            : { summary: "r3-action", actions: [{ kind: "tool", tool, params }] },
      },
      assembly: manifest.record,
      ...(compensator ? { compensator: (mode) => compensator.compensate(ref, { mode }) } : {}),
    });
    cell.attachRun(ref);
    const status = (await done) as RunStatus;
    return { ref, cell, status, events: await readRun(ref.runId) };
  }

  it("预存在文件：create 失败、不覆盖、不被 builtin 删除", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-r3-exists" };
    const target = `${allowedRoot}/preexist.txt`;
    await writeFile(target, "keep", "utf8");
    const { ref, status, events } = await runTool(scope, "run-r3-exists", "write_file", {
      path: target,
      content: "new",
    });
    expect(status.state).toBe("halted");
    expect(await readFile(target, "utf8")).toBe("keep");
    const settled = events.find((e) => e.type === "EFFECT_SETTLED")?.payload as {
      outcome?: string;
      receipt?: unknown;
    };
    expect(settled.outcome).toBe("failed-clean");
    expect(settled.receipt).toBeUndefined();

    const compensator = new CompensationExecutor({ ledger, factory: null });
    expect(await compensator.compensate(ref, { mode: "run" })).toBe(true);
    expect(await readFile(target, "utf8")).toBe("keep");
    expect((await readRun(ref.runId)).some((e) => e.type === "COMPENSATION_EXECUTED")).toBe(false);
  });

  it("覆盖写：收据 created:false，builtin 拒绝删除，内容保留", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-r3-overwrite" };
    const target = `${allowedRoot}/overwrite.txt`;
    await writeFile(target, "old", "utf8");
    const { ref, status, events } = await runTool(scope, "run-r3-overwrite", "overwrite_file", {
      path: target,
      content: "new",
    });
    expect(status.state).toBe("halted");
    expect(await readFile(target, "utf8")).toBe("new");
    const settled = events.find((e) => e.type === "EFFECT_SETTLED")?.payload as {
      receipt?: { created?: boolean; overwritten?: boolean; mode?: string };
    };
    expect(settled.receipt).toMatchObject({
      mode: "overwrite",
      created: false,
      overwritten: true,
    });

    const compensator = new CompensationExecutor({ ledger, factory: null });
    expect(await compensator.compensate(ref, { mode: "run" })).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new");
    expect((await readRun(ref.runId)).some((e) => e.type === "COMPENSATION_EXECUTED")).toBe(false);
  });

  it("路径逃逸：guard 放行字面值但宿主解析后拒绝，文件不落盘", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-r3-escape" };
    const outside = path.join(allowedRoot, "..", "escape.txt").replace(/\\/g, "/");
    const { status, events } = await runTool(scope, "run-r3-escape", "write_file", {
      path: outside,
      content: "nope",
    });
    expect(status.state).toBe("halted");
    await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
    expect(events.some((e) => e.type === "AUTH_DENIED")).toBe(true);
    const result = events.find((e) => e.type === "TOOL_RESULT")?.payload as ToolResultPayload;
    expect((result.error as { code?: string })?.code).toBe("AUTH/DENIED");
  });

  it("身份不符：文件被替换后 builtin 拒绝删除并升级", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-r3-identity" };
    const target = `${allowedRoot}/identity.txt`;
    const { ref, status } = await runTool(scope, "run-r3-identity", "write_file", {
      path: target,
      content: "original",
    });
    expect(status.state).toBe("halted");
    await writeFile(target, "tampered", "utf8");

    const compensator = new CompensationExecutor(
      { ledger, factory: null },
      { delay: async () => undefined },
    );
    expect(await compensator.compensate(ref, { mode: "run" })).toBe(false);
    expect(await readFile(target, "utf8")).toBe("tampered");
    const evs = await readRun(ref.runId);
    expect(evs.some((e) => e.type === "COMPENSATION_ESCALATED")).toBe(true);
    expect(evs.some((e) => e.type === "COMPENSATION_EXECUTED")).toBe(false);
  });

  it("同一 toolCallId 重试：复用 effectId 与收据，不重复写文件/不重复声明", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-r4-retry" };
    const ref: RunRef = { ...scope, runId: "run-r4-retry" };
    const { cell } = await wire(scope, ref.runId);
    cell.attachRun(ref);
    const target = `${allowedRoot}/retry.txt`;
    const call = {
      tool: "write_file",
      params: { path: target, content: "retry" },
      toolCallId: "call-retry-1",
    };

    expect(await cell.executor(call)).toMatchObject({ status: "ok" });
    expect(await cell.executor(call)).toMatchObject({ status: "ok" });
    expect(await readFile(target, "utf8")).toBe("retry");
    const evs = await readRun(ref.runId);
    expect(evs.filter((e) => e.type === "EFFECT_DECLARED")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "EFFECT_SETTLED")).toHaveLength(1);
  });

  it("多 effect 部分失败：只补偿真正创建的那一个", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-r4-multi" };
    const pathA = `${allowedRoot}/multi-a.txt`;
    const pathB = `${allowedRoot}/multi-b.txt`;
    await writeFile(pathB, "keep", "utf8");
    const { ref, status, events } = await runTool(scope, "run-r4-multi", "write_two", {
      pathA,
      pathB,
    });
    expect(status.state).toBe("halted");
    expect(await readFile(pathA, "utf8")).toBe("a");
    expect(await readFile(pathB, "utf8")).toBe("keep");
    expect(events.filter((e) => e.type === "EFFECT_DECLARED")).toHaveLength(2);
    const receipts = events
      .filter((e) => e.type === "EFFECT_SETTLED")
      .map((e) => (e.payload as { receipt?: { created?: boolean } }).receipt);
    expect(receipts.filter((r) => r?.created === true)).toHaveLength(1);
    expect(receipts.filter((r) => r === undefined)).toHaveLength(1);

    const compensator = new CompensationExecutor({ ledger, factory: null });
    expect(await compensator.compensate(ref, { mode: "run" })).toBe(true);
    await expect(access(pathA)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(pathB, "utf8")).toBe("keep");
    const executed = (await readRun(ref.runId)).filter((e) => e.type === "COMPENSATION_EXECUTED");
    expect(executed).toHaveLength(1);
  });

  it("R5：Cell 不继承宿主业务环境变量；cwd = 唯一写根", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-r5-env" };
    const ref: RunRef = { ...scope, runId: "run-r5-env" };
    const { cell } = await wire(scope, ref.runId);
    cell.attachRun(ref);
    const r = (await cell.executor({ tool: "env_probe", params: {} })) as {
      status: string;
      result: { secret: string | null; nodeOptions: string | null; cwd: string };
    };
    expect(r.status).toBe("ok");
    expect(r.result.secret).toBeNull();
    expect(r.result.nodeOptions).toBeNull();
    expect(r.result.cwd.replace(/\\/g, "/")).toBe(allowedRoot);
  });
});
