/**
 * 集成测试（真实进程）—— Phase 4 切片④ `kind:"engine"`（锚 D3 / D5；03 稿 E1~E9）。
 *
 * 本文件先于实现存在（standards/05 红测先行）：它钉住——
 * 1. D3 多步闭环：engine Cell 每步经 `engine.step` 拿投影消息、调模型、返回决策；
 *    工具仍由 Core 执行；file-write 真写盘、补偿可回放；账本事件序完整；
 * 2. D3 故障半径：kill engine Cell → RUN_FAILED{ENGINE_EXITED}、在途模型调用收束、
 *    已声明 effect 可补偿、并行 run 不受影响；
 * 3. D5 可重放归因：每步 DECISION.basedOn 覆盖模型事件与上一步工具结果；
 *    账本表面投影可重算出同一消息序列；
 * 4. D2 预算熔断：超预算的下一跳被拒、run 干净收束、无未落账调用；
 * 5. 协议封闭：未知字段 / 未声明工具 / 超 maxSteps 各一条拒绝用例；
 * 6. D4 密钥红线：engine 装配记录与账本零密钥值。
 */

import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  appendTurnInput,
  projectSurface,
  type AssemblyRecordedPayload,
  type DecisionPayload,
  type LedgerEvent,
  type ModelMessagePayload,
  type RunRef,
  type ToolResultPayload,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  CompensationExecutor,
  EngineDriver,
  ProcessIsolationProvider,
  assembleProfile,
  loadProfile,
  type LoadedManifest,
  type ProfileAssembly,
  type ProfilePlan,
  type ProfilePluginPlan,
  type SupervisedCell,
} from "@keel/host";

const repoRoot = process.cwd();
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "profile");
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const policyCellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "policy-main.js");
const SECRET_REF = "KEEL_MODEL_MOCK_KEY";
const SECRET_VALUE = "sk-test-engine-kind-e2e";

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

let dir: string;
let workspaceRoot: string;
let ledger: Ledger;
let auth: Authorizer;
let budget: Budgeter;
let gateway: ModelGateway;
let ctx: ToolCatalog;
let hooks: HookBus;
let scheduler: Scheduler;
let supervisor: CellSupervisor;
const opened: ProfileAssembly[] = [];
const engineCells = new Set<SupervisedCell>();

beforeAll(async () => {
  process.env[SECRET_REF] = SECRET_VALUE;
  dir = await mkdtemp(path.join(tmpdir(), "keel-engine-kind-"));
  workspaceRoot = path.join(dir, "workspace").replace(/\\/g, "/");
  await mkdir(workspaceRoot, { recursive: true });

  ledger = new Ledger({ rootDir: dir });
  // 测试台全放行：本片验证 engine 的通道与治理形状，授权矩阵由既有用例守。
  auth = new Authorizer(
    { version: "p-engine", allow: [{ subject: "*", action: "*", resource: "*" }] },
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
      if (!ref) return;
      // 与 CLI runtime 同一映射：engine 舱退出 = ENGINE_EXITED（R8 的原因码）。
      const reasonCode = engineCells.has(e.cell) ? "ENGINE_EXITED" : e.reasonCode;
      void scheduler.abort(ref.runId, reasonCode, e.message);
    },
  });
});

afterAll(async () => {
  delete process.env[SECRET_REF];
  await Promise.allSettled(opened.map((a) => a.close()));
  await ledger.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf-8")) as Record<string, unknown>;
}

async function load(name: string): Promise<ProfilePlan> {
  return loadProfile(path.join(fixtureRoot, name, "profile.yaml"), {
    profileSchema,
    assembler,
  });
}

/** 内存装配清单（崩溃/写盘用例要按临时工作区改 file-write 的 allow）。 */
function planOf(
  entries: { id: string; raw: Record<string, unknown>; modulePath: string }[],
): ProfilePlan {
  const scope = { agentId: "react-write", sessionId: "main" };
  const plugins: ProfilePluginPlan[] = entries.map((e) => {
    const manifest: LoadedManifest = assembler.assemble(e.raw);
    return {
      id: e.id,
      kind: manifest.kind,
      manifest,
      manifestPath: "",
      modulePath: path.join(repoRoot, e.modulePath),
      scope,
    };
  });
  return { name: "react-write", version: 1, scope, plugins };
}

/** 真实工作区的 file-write 报关单（只替换 allow 根目录这个部署环境量）。 */
function fileWriteManifest(): Record<string, unknown> {
  const raw = readJson("packages/plugins/file-write/keel-plugin.json");
  for (const p of raw.permissions as { cap: string; allow?: string[] }[]) {
    if (p.cap === "fs.write") p.allow = [`fs:${workspaceRoot}/**`];
  }
  return raw;
}

/** model-mock 报关单（崩溃用例要放大空闲看门狗，好让"模型还在想"的窗口可命中）。 */
function modelManifest(idleMs = 30_000): Record<string, unknown> {
  const raw = readJson("packages/plugins/model-mock/keel-plugin.json");
  (raw.model as { timeouts?: { idleMs?: number } }).timeouts = { idleMs };
  return raw;
}

/** engine 报关单（把工具清单换成指定工具；模型 ref 对齐 profile 里的插件 id）。 */
function engineManifest(tools: string[], maxSteps = 8): Record<string, unknown> {
  const raw = readJson("packages/plugins/engine-react/keel-plugin.json");
  const engine = raw.engine as { tools: string[]; maxSteps: number };
  engine.tools = tools;
  engine.maxSteps = maxSteps;
  return raw;
}

async function assemble(plan: ProfilePlan, runId: string): Promise<ProfileAssembly> {
  const assembly = await assembleProfile(plan, {
    supervisor,
    deps: { ledger, auth, budget, ctx, gateway },
    runId,
    policy: { bus: hooks, entryPath: policyCellEntry },
  });
  opened.push(assembly);
  if (assembly.engine) engineCells.add(assembly.engine.cell);
  return assembly;
}

function engineRun(
  assembly: ProfileAssembly,
  input: unknown,
): Promise<{ state: string; reasonCode?: string }> {
  const engine = assembly.engine;
  if (!engine) throw new Error("assembly has no engine");
  const driver = new EngineDriver({
    cell: engine.cell,
    engine: engine.decl,
    ledger,
    ref: assembly.ref,
  });
  const { done } = scheduler.start({
    ref: assembly.ref,
    subject: assembly.ref.agentId,
    executor: assembly.executor,
    driver,
    assembly: assembly.records,
    turnInput: { role: "user", content: JSON.stringify(input) },
  });
  for (const c of assembly.cells) c.cell.attachRun(c.ref);
  return done;
}

async function readRun(runId: string): Promise<LedgerEvent[]> {
  return (await ledger.read({ runId })).events;
}

function pick(evs: LedgerEvent[], type: string): Record<string, unknown>[] {
  return evs.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
}

async function until(pred: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("D3/D5：engine 多步 ReAct 闭环（真实进程）", () => {
  it("D3-a：模型 → 工具 → 模型 → 终结；表面事件、归因与用量全链可对账", async () => {
    const plan = await load("react-loop");
    const assembly = await assemble(plan, "run-react-ok");
    const status = await engineRun(assembly, {
      tool: "echo",
      arguments: { text: "hello-keel" },
      final: "react finished",
    });
    expect(status.state).toBe("halted");

    const evs = await readRun("run-react-ok");
    const types = evs.map((e) => e.type);
    // 表面事件先于首轮；两轮各一条 DECISION；正常完成是 reason 而不是 reasonCode。
    expect(types[0]).toBe("ASSEMBLY_RECORDED");
    expect(types.indexOf("TURN_INPUT")).toBeGreaterThan(types.indexOf("RUN_STARTED"));
    expect(types.indexOf("TURN_INPUT")).toBeLessThan(types.indexOf("ROUND_STARTED"));
    expect(pick(evs, "DECISION")).toHaveLength(2);
    expect(evs.find((e) => e.type === "RUN_HALTED")?.payload).toMatchObject({
      reason: "completed",
    });

    // 两轮模型调用：MODEL_INVOKED → BUDGET_SETTLED → MODEL_USAGE（每步一条）。
    expect(pick(evs, "MODEL_INVOKED")).toHaveLength(2);
    expect(pick(evs, "MODEL_USAGE")).toHaveLength(2);
    expect(pick(evs, "MODEL_USAGE").every((u) => u.pricedBy === "manifest")).toBe(true);
    expect(pick(evs, "MODEL_USAGE")[0]).toMatchObject({
      usageBuckets: { inputCached: 1_000_000, inputUncached: 1_000_000, output: 1_000_000 },
    });

    // 工具结果带模型给出的 toolCallId；模型消息的工具意图与之对得上。
    const result = pick(evs, "TOOL_RESULT")[0] as ToolResultPayload;
    expect(result).toMatchObject({ tool: "echo", status: "ok", toolCallId: "call-1" });
    expect((result.resultDigest as { echoed?: string }).echoed).toBe("hello-keel");
    const messages = pick(evs, "MODEL_MESSAGE") as unknown as ModelMessagePayload[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.toolCalls?.[0]).toMatchObject({ id: "call-1", name: "echo" });
    expect(messages[0]?.reasoningContent).toBe("need a tool");
    expect(messages[1]?.content).toBe("react finished");

    // ADR-0021 纯投影：账本重算出同一消息序列（user → assistant(tool) → tool → assistant）。
    const projected = projectSurface(evs);
    expect(projected.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(projected[2]?.toolCallId).toBe("call-1");
  });

  it("D5：每步 DECISION.basedOn 覆盖模型事件与上一步工具结果（可重放归因）", async () => {
    const evs = await readRun("run-react-ok");
    const decisions = evs.filter((e) => e.type === "DECISION");
    const usageSeqs = evs.filter((e) => e.type === "MODEL_USAGE").map((e) => e.seq);
    const toolSeq = evs.find((e) => e.type === "TOOL_RESULT")?.seq as number;

    for (const d of decisions) {
      const p = d.payload as DecisionPayload;
      // 本步的模型调用（含用量）必须在依据里——网关直写事件不靠"上界"含糊带过。
      expect(p.basedOn.some((seq) => usageSeqs.includes(seq))).toBe(true);
      expect(p.throughSeq).toBeGreaterThanOrEqual(Math.max(...p.basedOn));
    }
    // 第二轮决策额外引用上一步工具结果。
    expect((decisions[1]?.payload as DecisionPayload).basedOn).toContain(toolSeq);
    // 第一步决策时还没有工具结果。
    expect((decisions[0]?.payload as DecisionPayload).basedOn).not.toContain(toolSeq);
  });

  it("D3-b：file-write 真写盘；effect 收据进账本、补偿可回放删除", async () => {
    const target = `${workspaceRoot}/engine-write.txt`;
    const plan = planOf([
      {
        id: "model-mock",
        raw: modelManifest(),
        modulePath: "packages/plugins/model-mock/dist/index.js",
      },
      {
        id: "engine-react",
        raw: engineManifest(["write_file"]),
        modulePath: "packages/plugins/engine-react/dist/index.js",
      },
      {
        id: "file-write",
        raw: fileWriteManifest(),
        modulePath: "packages/plugins/file-write/dist/index.js",
      },
    ]);
    const assembly = await assemble(plan, "run-react-write");
    const status = await engineRun(assembly, {
      tool: "write_file",
      arguments: { path: target, content: "written by react" },
      final: "write done",
    });
    expect(status.state).toBe("halted");
    expect(await readFile(target, "utf8")).toBe("written by react");

    const evs = await readRun("run-react-write");
    expect(pick(evs, "EFFECT_DECLARED")).toHaveLength(1);
    expect(pick(evs, "EFFECT_SETTLED")[0]).toMatchObject({ outcome: "done" });
    // 补偿在环内：只读账本就能把本次创建删掉。
    const compensator = new CompensationExecutor({ ledger, factory: null });
    expect(await compensator.compensate(assembly.ref, { mode: "run" })).toBe(true);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("D3-c：kill engine Cell → RUN_FAILED{ENGINE_EXITED}、在途模型收束、并行 run 不受影响", async () => {
    const target = `${workspaceRoot}/crash-write.txt`;
    const plan = planOf([
      {
        id: "model-mock",
        raw: modelManifest(),
        modulePath: "packages/plugins/model-mock/dist/index.js",
      },
      {
        id: "engine-react",
        raw: engineManifest(["write_file"]),
        modulePath: "packages/plugins/engine-react/dist/index.js",
      },
      {
        id: "file-write",
        raw: fileWriteManifest(),
        modulePath: "packages/plugins/file-write/dist/index.js",
      },
    ]);
    const crash = await assemble(plan, "run-react-crash");
    const crashRun = engineRun(crash, {
      tool: "write_file",
      arguments: { path: target, content: "before crash" },
      final: "never reached",
      scenario: "slow",
      delayMs: 800,
    });

    // 并行 run：与崩溃 run 不同 scope / 不同 Cell。
    // 模型名在宿主进程内全局注册：并行装配必须用同一份 model 声明（否则后装配者会换掉
    // 崩溃 run 正在用的上游实例，测试就测不到"舱崩溃"而是"模型被换掉"）。
    const parallelPlan = planOf([
      {
        id: "model-mock",
        raw: modelManifest(),
        modulePath: "packages/plugins/model-mock/dist/index.js",
      },
      {
        id: "engine-react",
        raw: engineManifest(["echo"]),
        modulePath: "packages/plugins/engine-react/dist/index.js",
      },
      {
        id: "echo",
        raw: readJson("packages/plugins/echo/keel-plugin.json"),
        modulePath: "packages/plugins/echo/dist/index.js",
      },
    ]);
    const parallel = await assemble(parallelPlan, "run-react-parallel");
    const parallelRun = engineRun(parallel, {
      tool: "echo",
      arguments: { text: "parallel" },
      final: "parallel done",
    });

    // 等"工具已落盘、模型还在想"的窗口：TOOL_RESULT 出现后杀舱。
    await until(async () =>
      (await readRun("run-react-crash")).some((e) => e.type === "TOOL_RESULT"),
    );
    await crash.engine?.cell.kill();

    const status = await crashRun;
    expect(status.state).toBe("failed");
    expect(status.reasonCode).toBe("ENGINE_EXITED");
    expect((await parallelRun).state).toBe("halted");

    // 已落盘的副作用仍在；收据与声明完整（补偿仍可执行——故障半径止于本 run）。
    expect(await readFile(target, "utf8")).toBe("before crash");
    // 在途模型调用最终收束：每条 MODEL_INVOKED 都有用量或结算收尾。
    await until(async () => {
      const evs = await readRun("run-react-crash");
      const invoked = evs.filter((e) => e.type === "MODEL_INVOKED").length;
      const settled = evs.filter(
        (e) => e.type === "MODEL_USAGE" || e.type === "BUDGET_SETTLED",
      ).length;
      return settled >= invoked;
    });
    const evs = await readRun("run-react-crash");
    expect(evs.filter((e) => e.type === "EFFECT_DECLARED")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "EFFECT_SETTLED")).toHaveLength(1);

    const compensator = new CompensationExecutor({ ledger, factory: null });
    expect(await compensator.compensate(crash.ref, { mode: "run" })).toBe(true);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});

describe("D2：engine 驱动的模型调用预算熔断", () => {
  it("注入超预算 → 下一跳被拒、RUN_FAILED{BUDGET/EXHAUSTED}、无未落账调用", async () => {
    const plan = await load("react-loop");
    const assembly = await assemble(plan, "run-react-budget");
    budget.configure(assembly.ref, { run: 1 });
    const status = await engineRun(assembly, {
      tool: "echo",
      arguments: { text: "budget" },
      final: "budget done",
    });
    expect(status.state).toBe("failed");
    expect(status.reasonCode).toBe("BUDGET/EXHAUSTED");

    const evs = await readRun("run-react-budget");
    // 第一次调用 0.7；第二次预扣 1 就超了（0.7 + 1 > 1），连 MODEL_INVOKED 都不该有。
    expect(pick(evs, "MODEL_INVOKED")).toHaveLength(1);
    expect(pick(evs, "MODEL_USAGE")).toHaveLength(1);
    const invoked = evs.filter((e) => e.type === "MODEL_INVOKED").length;
    const settled = evs.filter(
      (e) => e.type === "MODEL_USAGE" || e.type === "BUDGET_SETTLED",
    ).length;
    expect(settled).toBeGreaterThanOrEqual(invoked);
  });
});

describe("协议封闭（03 稿 E3/§6）：未知字段、未声明工具、超步数", () => {
  const baseRef = (runId: string): RunRef => ({ agentId: "proto", sessionId: "main", runId });

  async function driverFor(runId: string, response: unknown): Promise<EngineDriver> {
    const ref = baseRef(runId);
    await appendTurnInput(ledger, ref, { role: "user", content: "x" });
    const cell = {
      stepEngine: async () => response,
    } as unknown as SupervisedCell;
    return new EngineDriver({
      cell,
      engine: {
        loop: "react",
        model: { ref: "model-mock", name: "mock-chat" },
        tools: ["echo"],
        maxSteps: 3,
      },
      ledger,
      ref,
    });
  }

  const roundContext = (runId: string, round: number) => ({
    run: baseRef(runId),
    round,
    tools: [{ name: "echo", schemaVersion: 1, schema: {} }],
    history: [],
    events: [],
  });

  it("响应里的未知字段 → ENGINE_PROTOCOL（不静默忽略）", async () => {
    const driver = await driverFor("run-proto-unknown", {
      decision: { kind: "done", summary: "ok" },
      extra: true,
    });
    await expect(driver.decide(roundContext("run-proto-unknown", 1))).rejects.toMatchObject({
      code: "ENGINE_PROTOCOL",
    });
  });

  it("未声明的工具名 → ENGINE_PROTOCOL（未声明 = 不存在）", async () => {
    const driver = await driverFor("run-proto-tool", {
      decision: {
        kind: "act",
        actions: [{ tool: "not-declared", params: {}, toolCallId: "c1" }],
      },
    });
    await expect(driver.decide(roundContext("run-proto-tool", 1))).rejects.toMatchObject({
      code: "ENGINE_PROTOCOL",
    });
  });

  it("超过 maxSteps → 不再问引擎，按 MAX_STEPS 收束", async () => {
    const driver = await driverFor("run-proto-steps", {
      decision: { kind: "done", summary: "should not be asked" },
    });
    const decision = await driver.decide(roundContext("run-proto-steps", 4));
    expect(decision).toMatchObject({ done: true, haltReason: "MAX_STEPS" });
  });
});

describe("D4：engine 装配记录与账本零密钥值", () => {
  it("装配记录、账本事件里不出现密钥值；engine 舱跑在子进程", async () => {
    const evs = await readRun("run-react-ok");
    expect(JSON.stringify(evs)).not.toContain(SECRET_VALUE);
    const records = evs
      .filter((e) => e.type === "ASSEMBLY_RECORDED")
      .map((e) => e.payload as AssemblyRecordedPayload);
    expect(records.some((r) => r.manifest.kind === "engine")).toBe(true);
    expect(JSON.stringify(records)).not.toContain(SECRET_VALUE);
    const assembly = opened.find((a) => a.ref.runId === "run-react-ok");
    const snapshot = (await assembly?.engine?.cell.pullSnapshot()) as { pid?: number } | undefined;
    expect(typeof snapshot?.pid).toBe("number");
    expect(snapshot?.pid).not.toBe(process.pid);
  });
});
