/**
 * 集成测试（真实进程）—— Phase 4 切片② Profile 装配面端到端（01 稿 P4/P5/P6/P7；锚 D1）。
 *
 * 本文件先于实现存在（standards/05 红测先行）：它钉住 D1 的机械断言——
 * 1. 五 kind 全家桶经一份 `profile.yaml` 拉起：model = 宿主内模块、engine/capability = 子进程、
 *    policy = 策略舱、observation = 无运行时；
 * 2. 逐插件装配记录按声明序落账本（run 的**首批**事件），载荷带 `profile` / `plugin`；
 * 3. 未声明/无运行时的模块零 import（探针全局变量不存在）；
 * 4. 五步校验零豁免：坏 manifest 混进 profile → 整份拒绝、零事件；
 * 5. 跨 scope 工具互不可见（C1 回归）；
 * 6. 绝对路径即拒（P3）。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Authorizer,
  Budgeter,
  HookBus,
  Ledger,
  ModelGateway,
  Scheduler,
  ToolCatalog,
  type AssemblyRecordedPayload,
  type LedgerEvent,
  type RunDriver,
  type ToolResultPayload,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  ProcessIsolationProvider,
  assembleProfile,
  loadProfile,
  type ProfileAssembly,
  type ProfilePlan,
} from "@keel/host";

const repoRoot = process.cwd();
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "profile");
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const policyCellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "policy-main.js");
const profileSchema = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-4", "schema", "keel-profile.schema.json"),
    "utf-8",
  ),
) as object;
const manifestSchema = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
) as object;

const assembler = new Assembler({ schema: manifestSchema });
const g = globalThis as Record<string, unknown>;

let dir: string;
let ledger: Ledger;
let auth: Authorizer;
let budget: Budgeter;
let gateway: ModelGateway;
let ctx: ToolCatalog;
let hooks: HookBus;
let scheduler: Scheduler;
let supervisor: CellSupervisor;
const opened: ProfileAssembly[] = [];

beforeAll(async () => {
  process.env.KEEL_TEST_MODEL_KEY = "sk-test-profile-fixture";
  dir = await mkdtemp(path.join(tmpdir(), "keel-profile-e2e-"));
  ledger = new Ledger({ rootDir: dir });
  // 测试台全放行：本片验证的是装配面与记录，不是授权矩阵（授权由既有 C1 用例守）
  auth = new Authorizer(
    { version: "p-profile", allow: [{ subject: "*", action: "*", resource: "*" }] },
    ledger,
  );
  budget = new Budgeter(ledger);
  ctx = new ToolCatalog();
  gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
  });
  hooks = new HookBus(ledger);
  scheduler = new Scheduler({ ledger, auth, budget, ctx, hooks, gateway });
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
  await Promise.allSettled(opened.map((a) => a.close()));
  await ledger.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function load(name: string): Promise<ProfilePlan> {
  return loadProfile(path.join(fixtureRoot, name, "profile.yaml"), {
    profileSchema,
    assembler,
  });
}

async function assemble(plan: ProfilePlan, runId: string): Promise<ProfileAssembly> {
  const assembly = await assembleProfile(plan, {
    supervisor,
    deps: { ledger, auth, budget, ctx, gateway },
    runId,
    policy: { bus: hooks, entryPath: policyCellEntry },
  });
  opened.push(assembly);
  return assembly;
}

async function readRun(runId: string): Promise<LedgerEvent[]> {
  return (await ledger.read({ runId })).events;
}

function startRun(
  assembly: ProfileAssembly,
  driver: RunDriver,
): Promise<{ state: string; reasonCode?: string }> {
  const { done } = scheduler.start({
    ref: assembly.ref,
    subject: assembly.ref.agentId,
    executor: assembly.executor,
    driver,
    assembly: assembly.records,
  });
  for (const c of assembly.cells) c.cell.attachRun(c.ref);
  return done;
}

describe("Phase 4 切片②：Profile 装配面（真实进程）", () => {
  it("D1-a：五 kind 各进各的隔离环境，model 与宿主同 pid、engine/capability 不同 pid", async () => {
    const plan = await load("all-kinds");
    expect(plan.plugins.map((p) => [p.id, p.kind])).toEqual([
      ["model-mock", "model"],
      ["engine-react", "engine"],
      ["pid-probe", "capability"],
      ["danger-guard", "policy"],
      ["audit-log", "observation"],
    ]);

    const assembly = await assemble(plan, "run-kinds");

    // model = 宿主进程内模块（create 在宿主执行）
    expect(g.__keelModelModuleLoads).toBe(1);
    expect(g.__keelModelPid).toBe(process.pid);
    expect(g.__keelModelSecretRef).toBe("KEEL_TEST_MODEL_KEY");
    expect(g.__keelModelSecretPresent).toBe(true);
    expect(assembly.plugins.find((p) => p.kind === "model")?.cell).toBeUndefined();

    // engine = Cell 子进程（快照应答带子进程 pid）
    const engine = assembly.plugins.find((p) => p.kind === "engine");
    expect(engine?.cell).toBeDefined();
    const snap = (await engine?.cell?.pullSnapshot()) as { pid?: number } | undefined;
    expect(typeof snap?.pid).toBe("number");
    expect(snap?.pid).not.toBe(process.pid);

    // policy = 独立策略舱；observation = 无运行时
    expect(assembly.policies).toHaveLength(1);
    expect(assembly.plugins.find((p) => p.kind === "policy")?.cell).toBeUndefined();
    expect(assembly.plugins.find((p) => p.kind === "observation")?.cell).toBeUndefined();

    // 未声明/无运行时模块零 import
    expect(g.__keelWildModuleLoads).toBeUndefined();
  });

  it("D1-b：逐插件装配记录按声明序落账本（run 首批事件）+ 工具经组合执行器路由", async () => {
    const plan = await load("all-kinds");
    const assembly = await assemble(plan, "run-records");

    const status = await startRun(assembly, {
      decide: async (c) =>
        c.round === 1
          ? { summary: "r1", actions: [{ kind: "tool", tool: "pid", params: {} }] }
          : { done: true, summary: "end" },
    });
    expect(status.state).toBe("halted");

    const evs = await readRun("run-records");
    const records = evs.filter((e) => e.type === "ASSEMBLY_RECORDED");
    expect(records).toHaveLength(plan.plugins.length);
    // 首批事件 = 全部装配记录（先于 RUN_STARTED），按声明序
    expect(evs.slice(0, plan.plugins.length).map((e) => e.type)).toEqual(
      plan.plugins.map(() => "ASSEMBLY_RECORDED"),
    );
    expect(evs[plan.plugins.length]?.type).toBe("RUN_STARTED");
    expect(records.map((e) => (e.payload as AssemblyRecordedPayload).plugin?.id)).toEqual(
      plan.plugins.map((p) => p.id),
    );
    for (const r of records) {
      const body = r.payload as AssemblyRecordedPayload;
      expect(body.profile).toEqual({ name: "local-workspace", version: 1 });
      expect(body.plugin?.id).toBeTruthy();
    }

    // 组合执行器把 pid 路由到 capability Cell（结果里的 pid ≠ 宿主 pid）
    const result = evs.find((e) => e.type === "TOOL_RESULT")?.payload as ToolResultPayload;
    expect(result.status).toBe("ok");
    expect((result.resultDigest as { pid?: number }).pid).not.toBe(process.pid);
  });

  it("D1-c：五步校验零豁免——坏 manifest 混进 profile → 整份拒绝、零事件", async () => {
    const before = g.__keelWildModuleLoads;
    let caught: unknown;
    try {
      await load("bad-manifest");
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("SCHED/MANIFEST-INVALID");
    expect(g.__keelWildModuleLoads).toBe(before);
    // 装配前失败不进账本（run 未启动）：未知 runId 没有任何可读事件
    await expect(ledger.read({ runId: "run-never" })).rejects.toMatchObject({
      code: "LEDGER/CURSOR-INVALID",
    });
  });

  it("D1-d：跨 scope 工具互不可见（C1 回归）", async () => {
    const a = await assemble(await load("scope-echo"), "run-scope-a");
    const b = await assemble(await load("scope-pid"), "run-scope-b");
    const seenA: string[][] = [];
    const seenB: string[][] = [];

    const [sa, sb] = await Promise.all([
      startRun(a, {
        decide: async (c) => {
          seenA.push(c.tools.map((t) => t.name));
          return { done: true, summary: "a-end" };
        },
      }),
      startRun(b, {
        decide: async (c) => {
          seenB.push(c.tools.map((t) => t.name));
          return { done: true, summary: "b-end" };
        },
      }),
    ]);
    expect(sa.state).toBe("halted");
    expect(sb.state).toBe("halted");
    expect(seenA).toEqual([["echo"]]);
    expect(seenB).toEqual([["pid"]]);
  });

  it("D1-e：绝对路径即拒（P3）", async () => {
    const pdir = await mkdtemp(path.join(tmpdir(), "keel-profile-abs-"));
    try {
      const abs = path.join(repoRoot, "packages", "plugins", "echo", "dist", "index.js");
      const file = path.join(pdir, "profile.yaml");
      await writeFile(
        file,
        [
          "version: 1",
          "name: abs-profile",
          "plugins:",
          "  - id: echo",
          "    kind: capability",
          `    manifest: ${JSON.stringify(abs)}`,
          `    module: ${JSON.stringify(abs)}`,
          "",
        ].join("\n"),
        "utf-8",
      );
      expect(() => loadProfile(file, { profileSchema, assembler })).toThrow(
        /absolute path|绝对路径/i,
      );
    } finally {
      await rm(pdir, { recursive: true, force: true });
    }
  });
});
