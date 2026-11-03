/**
 * 集成测试（真实进程）—— 切片④ 插件 B `file-write` 转正件（08 稿 §5，锚 C3【一票否决】）。
 *
 * B-E1 补偿闭环主体：write_file 真实落盘 → 注入 run 失败 → 调度器触发 builtin fs.remove
 *     → 文件消失；账本全链 EFFECT_DECLARED(builtin) → EFFECT_SETTLED(receipt.created:true
 *     + identity) → COMPENSATION_EXECUTED(removed)。
 * B-E2 越界拒零部分生效：allow 外路径 handler 零执行，AUTH_DENIED(fs.write) 留痕。
 * B-E3 重试幂等：同 toolCallId 复用收据，不重复声明/写。
 * B-E4 状态可恢复（I3）：补偿器只读账本即可重放补偿候选；已补偿效果幂等不再执行。
 *
 * 与 tests/native-file-write-aop.test.ts（切片③机制样例 fixture）的分工见 08 稿 §5：
 * 本文件以**转正件**（packages/plugins/file-write）为准补 C3；
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
const pluginPath = path.join(repoRoot, "packages", "plugins", "file-write", "dist", "index.js");
const manifestPath = path.join(repoRoot, "packages", "plugins", "file-write", "keel-plugin.json");
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
  dir = await mkdtemp(path.join(tmpdir(), "keel-fw-e2e-"));
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
      version: "p-fw-e2e",
      allow: [
        ...manifestAuthRules(manifest, "agent-b"),
        { subject: "agent-b", action: "tool.invoke", resource: "*" },
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
    onCellExit: () => {
      /* 直连 executor 的测试没有注册 run：退出通知无需 abort */
    },
  });
});

afterAll(async () => {
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

describe("切片④ 插件 B（转正件）：C3 补偿闭环（真实进程）", () => {
  it("B-E1：写入生效 → 注入 run 失败 → builtin fs.remove 删除 → 账本全链可归因", async () => {
    const scope: Scope = { agentId: "agent-b", sessionId: "sess-fw-e1" };
    const { ref, cell } = await wire(scope, "run-fw-e1");
    const target = `${allowedRoot}/compensated.txt`;
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
              { kind: "tool", tool: "write_file", params: { path: target, content: "keel" } },
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
    // 回滚闭环：本次创建的文件消失
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });

    const evs = await readRun(ref.runId);
    expect(evs.some((e) => e.type === "RUN_FAILED")).toBe(true);

    // 声明先于副作用留痕，补偿语义由 manifest 驱动（插件零治理代码）
    const declared = evs.find((e) => e.type === "EFFECT_DECLARED");
    expect((declared?.payload as EffectDeclaredPayload) ?? null).toMatchObject({
      kind: "fs.write.done",
      targetSummary: { path: target },
      compensationClass: "reversible",
      compensation: { actionRef: "fs.remove", actionType: "builtin", idempotency: "natural" },
    });

    // 事实层：收据证明"本次创建"，身份可核对（builtin 删除的唯一凭据）
    const settledPayload = evs.find((e) => e.type === "EFFECT_SETTLED")?.payload as {
      receipt?: { created?: boolean; target?: string; identity?: Record<string, unknown> };
    };
    expect(settledPayload.receipt).toBeDefined();
    expect(settledPayload.receipt?.created).toBe(true);
    expect(settledPayload.receipt?.target).toBe(target);
    expect(settledPayload.receipt?.identity).toMatchObject({
      dev: expect.any(String),
      ino: expect.any(String),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // 补偿闭环落账
    expect(evs.filter((e) => e.type === "COMPENSATION_EXECUTED")).toHaveLength(1);
    expect(evs.find((e) => e.type === "COMPENSATION_EXECUTED")?.payload).toMatchObject({
      resultDigest: { removed: target },
    });
  });

  it("B-E2：allow 外路径被拒 → handler 零执行、零部分生效、AUTH_DENIED 留痕", async () => {
    const scope: Scope = { agentId: "agent-b", sessionId: "sess-fw-e2" };
    const { ref, cell } = await wire(scope, "run-fw-e2");
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
      subject: "agent-b",
      action: "fs.write",
      resource: `fs:${outside}`,
    });
    // 未声明 = 未发生：没有声明也没有结算，零部分生效
    expect(evs.some((e) => e.type === "EFFECT_DECLARED")).toBe(false);
    expect(evs.some((e) => e.type === "EFFECT_SETTLED")).toBe(false);
    const result = evs.find((e) => e.type === "TOOL_RESULT")?.payload as ToolResultPayload;
    expect(result.status).toBe("error");
    expect((result.error as { code?: string })?.code).toBe("AUTH/DENIED");
    expect((denied[0]?.payload as AuthDeniedPayload).policyVersion).toBe("p-fw-e2e");
  });

  it("B-E3：同一 toolCallId 重试 → 复用收据，不重复声明/结算/写", async () => {
    const scope: Scope = { agentId: "agent-b", sessionId: "sess-fw-e3" };
    const ref: RunRef = { ...scope, runId: "run-fw-e3" };
    const { cell } = await wire(scope, ref.runId);
    cell.attachRun(ref);
    const target = `${allowedRoot}/retry.txt`;
    const call = {
      tool: "write_file",
      params: { path: target, content: "retry" },
      toolCallId: "call-fw-retry-1",
    };

    expect(await cell.executor(call)).toMatchObject({ status: "ok" });
    expect(await cell.executor(call)).toMatchObject({ status: "ok" });
    expect(await readFile(target, "utf8")).toBe("retry");
    const evs = await readRun(ref.runId);
    expect(evs.filter((e) => e.type === "EFFECT_DECLARED")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "EFFECT_SETTLED")).toHaveLength(1);
  });

  it("B-E4：补偿器只读账本可恢复；已补偿效果重放补偿幂等", async () => {
    // 复用 B-E1 的账本（run-fw-e1 已补偿）：新建一个与当时内存态无关的执行器
    const compensator = new CompensationExecutor({ ledger, factory: null });
    const ref: RunRef = { agentId: "agent-b", sessionId: "sess-fw-e1", runId: "run-fw-e1" };
    expect(await compensator.compensate(ref, { mode: "run" })).toBe(true);
    // 目标仍是已删除状态（没有被重复处理出错误），且账本不再新增补偿事件
    const evs = await readRun(ref.runId);
    expect(evs.filter((e) => e.type === "COMPENSATION_EXECUTED")).toHaveLength(1);
    await expect(access(`${allowedRoot}/compensated.txt`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("B-E5：预存在目标 → WORKSPACE/EXISTS 拒绝，内容保留，无收据不进补偿", async () => {
    const scope: Scope = { agentId: "agent-b", sessionId: "sess-fw-e5" };
    const target = `${allowedRoot}/preexist.txt`;
    await writeFile(target, "keep", "utf8");
    const { ref, cell } = await wire(scope, "run-fw-e5");

    const { done } = scheduler.start({
      ref,
      subject: scope.agentId,
      executor: cell.executor,
      driver: {
        decide: async (c) =>
          c.round > 1
            ? { done: true, summary: "exists-end" }
            : {
                summary: "exists",
                actions: [
                  { kind: "tool", tool: "write_file", params: { path: target, content: "new" } },
                ],
              },
      },
      assembly: manifest.record,
    });
    cell.attachRun(ref);

    const status = (await done) as RunStatus;
    expect(status.state).toBe("halted");
    expect(await readFile(target, "utf8")).toBe("keep");
    const evs = await readRun(ref.runId);
    const result = evs.find((e) => e.type === "TOOL_RESULT")?.payload as ToolResultPayload;
    expect(result.status).toBe("error");
    expect((result.error as { code?: string })?.code).toBe("WORKSPACE/EXISTS");
    // 失败的写入没有收据：内建删除不会碰这个预存在文件（0 误删）
    const compensator = new CompensationExecutor({ ledger, factory: null });
    expect(await compensator.compensate(ref, { mode: "run" })).toBe(true);
    expect(await readFile(target, "utf8")).toBe("keep");
    expect((await readRun(ref.runId)).some((e) => e.type === "COMPENSATION_EXECUTED")).toBe(false);
  });
});
