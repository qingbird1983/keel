/**
 * 集成测试（真实进程）—— 切片④ 插件 C `param-guard` 转正件（08 稿 §7，锚 C4）。
 *
 * 联装 = 转正插件 B（工具舱）+ 插件 C（策略舱，policy-link 装配，ADR-0012）同宿主；
 * 靶工具 = 插件 B 的 write_file（08 稿 K3）。
 *
 * C-E1 拦截 + 可归因：危险参数（content 含 TOPSECRET）被 deny，介入 seq 进 DECISION.basedOn，
 *     handler 未执行（文件不存在、无 EFFECT_DECLARED）。
 * C-E2 放行不误伤：正常 content → approve，文件落盘。
 * C-E3 崩溃降级（I2）：kill 策略舱 → 介入走既有 fallback（HOOK_VERDICT{fallback:true}），
 *     run 照常推进不崩（B7① 口径延续；策略舱不 attachRun）。
 * C-E4 无介入无事件：未申领的 hook 零 HOOK_CALLED；ASSEMBLY_RECORDED.policies 记账正确。
 */

import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  type RunRef,
  type RunStatus,
  type Scope,
  type ToolResultPayload,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  ProcessIsolationProvider,
  manifestAuthRules,
  wireCell,
  wirePolicies,
  type LoadedManifest,
  type PolicyBinding,
} from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const policyEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "policy-main.js");
const pluginPath = path.join(repoRoot, "packages", "plugins", "file-write", "dist", "index.js");
const manifestPath = path.join(repoRoot, "packages", "plugins", "file-write", "keel-plugin.json");
const policyModulePath = path.join(
  repoRoot,
  "packages",
  "plugins",
  "param-guard",
  "dist",
  "index.js",
);
const policyManifestPath = path.join(
  repoRoot,
  "packages",
  "plugins",
  "param-guard",
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
let ctxMgr: ContextManager;
let gateway: ModelGateway;
let scheduler: Scheduler;
let hookBus: HookBus;
let supervisor: CellSupervisor;
let manifest: LoadedManifest;
let allowedRoot: string;
let policyBinding: PolicyBinding | undefined;
const cells: { drainAndReap(): Promise<unknown> }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-pg-e2e-"));
  allowedRoot = path.join(dir, "workspace").replace(/\\/g, "/");
  await mkdir(allowedRoot, { recursive: true });

  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    permissions: { cap: string; allow?: string[] }[];
  };
  for (const p of raw.permissions) {
    if (p.cap === "fs.write") p.allow = [`fs:${allowedRoot}/**`];
  }
  manifest = new Assembler({ schema }).assemble(raw);
  const policyManifest = new Assembler({ schema }).assemble(
    JSON.parse(readFileSync(policyManifestPath, "utf-8")),
  );

  ledger = new Ledger({ rootDir: dir });
  auth = new Authorizer(
    {
      version: "p-pg-e2e",
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
  hookBus = new HookBus(ledger);
  scheduler = new Scheduler({
    ledger,
    auth,
    budget,
    ctx: ctxMgr,
    hooks: hookBus,
    gateway,
  });
  supervisor = new CellSupervisor({
    provider: new ProcessIsolationProvider(),
    cellEntryPath: cellEntry,
    toolKillGraceMs: 5_000,
    onCellExit: () => {
      /* 策略舱不 attachRun（ADR-0012）：工具舱退出也无需 abort（直连 executor 无注册 run） */
    },
  });

  // 策略舱（全部就绪后才注册；两策略争同一 hook = 整份拒绝，不在本用例面）；
  // 工具舱每 run 一只（wireCell 先例），在 runWrite 内起。
  const bindings = await wirePolicies({
    supervisor,
    bus: hookBus,
    specs: [{ manifest: policyManifest, modulePath: policyModulePath }],
    policyEntryPath: policyEntry,
  });
  expect(bindings).toHaveLength(1);
  policyBinding = bindings[0];
});

afterAll(async () => {
  await Promise.allSettled(cells.map((c) => c.drainAndReap()));
  await ledger.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function pl(e: LedgerEvent): Record<string, unknown> {
  return e.payload as Record<string, unknown>;
}

function hookPairs(events: LedgerEvent[], hook: string) {
  const called = events.filter((e) => e.type === "HOOK_CALLED" && pl(e).hook === hook);
  const verdicts = events.filter((e) => e.type === "HOOK_VERDICT" && pl(e).hook === hook);
  return called.map((c, i) => ({ called: c, verdict: verdicts[i] }));
}

/** 归因锚（V6）：介入的两个 seq 出现在之后某一轮 DECISION.basedOn 里。 */
function attributed(events: LedgerEvent[], seqs: number[]): boolean {
  return events
    .filter((e) => e.type === "DECISION")
    .some((e) => seqs.every((s) => (pl(e).basedOn as number[]).includes(s)));
}

async function runWrite(
  runId: string,
  params: { path: string; content: string },
): Promise<{ status: RunStatus; events: LedgerEvent[] }> {
  const scope: Scope = { agentId: "agent-b", sessionId: `sess-${runId}` };
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
  // 装配审计的 policies 摘要由调用方合入（runtime.ts 同口径：没绑策略不写字段）
  const assembly = { ...manifest.record, policies: [policyBinding!.summary] };
  const { done } = scheduler.start({
    ref,
    subject: scope.agentId,
    executor: cell.executor,
    driver: {
      decide: async (c) =>
        c.round > 1
          ? { done: true, summary: "pg-end" }
          : { summary: "pg-action", actions: [{ kind: "tool", tool: "write_file", params }] },
    },
    assembly,
  });
  cell.attachRun(ref);
  const status = (await done) as RunStatus;
  return { status, events: await ledger.read({ runId }).then((r) => r.events) };
}

describe("切片④ 插件 C（param-guard）：C4 策略介入（真实进程联装）", () => {
  it("C-E1：危险参数被拦 → AUTH/DENIED by policy-hook，介入可归因，handler 零执行", async () => {
    const target = `${allowedRoot}/guarded.txt`;
    const { status, events } = await runWrite(runIdOf("e1"), {
      path: target,
      content: "hello TOPSECRET world",
    });
    expect(status.state).toBe("halted"); // 动作级拒绝不改变 run 收束语义
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });

    const result = events.find((e) => e.type === "TOOL_RESULT")?.payload as ToolResultPayload;
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({
      code: "AUTH/DENIED",
      by: "policy-hook",
      reason: expect.stringContaining("TOPSECRET"),
    });

    const pairs = hookPairs(events, "toolApproval");
    expect(pairs).toHaveLength(1);
    expect(pl(pairs[0]!.verdict).fallback).toBe(false);
    expect(pl(pairs[0]!.verdict).verdict).toMatchObject({
      verdict: "deny",
      reason: expect.stringContaining("TOPSECRET"),
    });
    // 归因锚：介入的两个 seq 进 DECISION.basedOn（V6）
    expect(attributed(events, [pairs[0]!.called.seq, pairs[0]!.verdict.seq])).toBe(true);
    // 未发生即未声明：deny 发生在 handler 之前
    expect(events.some((e) => e.type === "EFFECT_DECLARED")).toBe(false);
  });

  it("C-E2：正常参数放行不误伤 → 文件落盘（联装成立）", async () => {
    const target = `${allowedRoot}/allowed.txt`;
    const { status, events } = await runWrite(runIdOf("e2"), {
      path: target,
      content: "plain content",
    });
    expect(status.state).toBe("halted");
    await expect(access(target)).resolves.toBeUndefined();

    const pairs = hookPairs(events, "toolApproval");
    expect(pairs).toHaveLength(1);
    expect(pl(pairs[0]!.verdict).verdict).toMatchObject({ verdict: "approve" });
    const result = events.find((e) => e.type === "TOOL_RESULT")?.payload as ToolResultPayload;
    expect(result.status).toBe("ok");
    expect(events.some((e) => e.type === "EFFECT_SETTLED")).toBe(true);
  });

  it("C-E3：kill 策略舱 → 介入走既有 fallback，run 照常推进不崩（I2）", async () => {
    expect(policyBinding).toBeDefined();
    await policyBinding!.cell.kill();
    const target = `${allowedRoot}/after-kill.txt`;
    const { status, events } = await runWrite(runIdOf("e3"), {
      path: target,
      content: "still works",
    });
    expect(status.state).toBe("halted");
    await expect(access(target)).resolves.toBeUndefined();

    const verdicts = events.filter((e) => e.type === "HOOK_VERDICT");
    expect(verdicts).toHaveLength(1);
    expect(pl(verdicts[0]!)).toMatchObject({ hook: "toolApproval", fallback: true });
  });

  it("C-E4：未申领的 hook 零介入；装配审计点得出绑了谁（ADR-0012 决策 6）", async () => {
    for (const runId of ["run-pg-e1", "run-pg-e2", "run-pg-e3"]) {
      const events = await ledger.read({ runId }).then((r) => r.events);
      for (const hook of ["stopAdvice", "retryAdvice", "budgetExhaustedChoice"]) {
        expect(events.filter((e) => e.type === "HOOK_CALLED" && pl(e).hook === hook)).toEqual([]);
      }
      const assembly = events.find((e) => e.type === "ASSEMBLY_RECORDED");
      expect(pl(assembly!).policies).toEqual([
        { name: "param-guard", version: "1.0.0", hooks: ["toolApproval"] },
      ]);
    }
  });
});

function runIdOf(tag: string): string {
  return `run-pg-${tag}`;
}
