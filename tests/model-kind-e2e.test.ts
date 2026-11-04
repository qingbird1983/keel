/**
 * 集成测试（真实装配）—— Phase 4 切片③ `kind:"model"`（锚 D2 / D4 / D6；红测先行的落地）。
 *
 * 本文件先于实现存在（standards/05）：它钉住七条机械断言——
 * 1. manifest 价格表 → 网关：模块只报三桶用量，费用由 Core 按宿主时钟判峰谷计算；
 * 2. 单次实结超预扣：`BUDGET_SETTLED{overrun:true}`、预算夹到限额（不出现负数）、下一跳被拒；
 * 3. 无未落账调用：每次 `MODEL_INVOKED` 都有 `MODEL_USAGE` 或 `BUDGET_SETTLED` 收束；
 * 4. 流式正常/中途抛/空闲看门狗：已产出部分永远结算，`truncated` 可对账；
 * 5. 非流式总时限到点与上游抛：先 settle(0) 再报错，不留悬空预扣；
 * 6. 模块自报 cost 与未注册模型：显式拒绝（费用权威在 Core）；
 * 7. 密钥红线：账本文件、装配记录、错误诊断里零密钥值；表面事件词汇按 R1 落账。
 */

import { readFileSync } from "node:fs";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Authorizer,
  Budgeter,
  Ledger,
  ModelGateway,
  SURFACE_EVENT_TYPES,
  ToolCatalog,
  appendModelMessage,
  appendTurnInput,
  isSurfaceEventType,
  type AssemblyRecordedPayload,
  type LedgerEvent,
  type ModelUsagePayload,
  type RunRef,
  type TurnInputPayload,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  ProcessIsolationProvider,
  assembleProfile,
  loadProfile,
  type ProfileAssembly,
} from "@keel/host";

const repoRoot = process.cwd();
const SECRET_REF = "KEEL_MODEL_MOCK_KEY";
const SECRET_VALUE = "sk-test-model-kind-e2e";
const PEAK = Date.parse("2026-11-04T02:00:00Z"); // 周三 02:00 UTC = 峰时窗口内
const OFF_PEAK = Date.parse("2026-11-04T12:00:00Z");
const BUCKETS = { inputCached: 1_000_000, inputUncached: 1_000_000, output: 1_000_000 };

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

let dir: string;
let ledger: Ledger;
let auth: Authorizer;
let budget: Budgeter;
let nowMs = OFF_PEAK;
let gateway: ModelGateway;
let supervisor: CellSupervisor;
let assembly: ProfileAssembly;

const stub = { invoke: async () => ({ result: {}, usage: BUCKETS }) };

beforeAll(async () => {
  process.env[SECRET_REF] = SECRET_VALUE;
  dir = await mkdtemp(path.join(tmpdir(), "keel-model-kind-"));
  ledger = new Ledger({ rootDir: dir });
  auth = new Authorizer(
    { version: "p-model", allow: [{ subject: "*", action: "*", resource: "*" }] },
    ledger,
  );
  budget = new Budgeter(ledger);
  gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: stub,
    now: () => nowMs,
    invokeTimeoutMs: 60, // 测试缝：真实默认 120s（契约 §7）
  });
  supervisor = new CellSupervisor({
    provider: new ProcessIsolationProvider(),
    cellEntryPath: path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js"),
    toolKillGraceMs: 5_000,
  });
  const plan = loadProfile(
    path.join(repoRoot, "tests", "fixtures", "profile", "model-kind", "profile.yaml"),
    {
      profileSchema,
      assembler: new Assembler({ schema: manifestSchema }),
    },
  );
  assembly = await assembleProfile(plan, {
    supervisor,
    deps: { ledger, auth, budget, ctx: new ToolCatalog(), gateway },
    runId: "run-asset",
  });
});

afterAll(async () => {
  delete process.env[SECRET_REF];
  await assembly?.close();
  await ledger?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function refOf(agent: string, runId: string): RunRef {
  return { agentId: agent, sessionId: `sess-${runId}`, runId };
}

async function readRun(runId: string): Promise<LedgerEvent[]> {
  return (await ledger.read({ runId })).events;
}

const pick = (evs: LedgerEvent[], type: string) =>
  evs.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);

describe("D2：模型调用计量与预算（manifest 价格表 + 三桶 + 峰谷）", () => {
  it("峰时按 peak 价、谷时按 offPeak 价；MODEL_USAGE v3 带桶/档/来源", async () => {
    const ref = refOf("agent-price", "run-price");
    nowMs = PEAK;
    const peak = await gateway.invoke(ref, "agent-price", {
      reqId: "price-peak",
      model: "mock-chat",
      params: {},
      estimate: 5,
    });
    expect(peak.cost).toBe(1.4);

    nowMs = OFF_PEAK;
    const off = await gateway.invoke(ref, "agent-price", {
      reqId: "price-off",
      model: "mock-chat",
      params: {},
      estimate: 5,
    });
    expect(off.cost).toBe(0.7);

    const evs = await readRun("run-price");
    const usages = pick(evs, "MODEL_USAGE") as unknown as ModelUsagePayload[];
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({
      reqId: "price-peak",
      cost: 1.4,
      usageBuckets: BUCKETS,
      tier: "peak",
      pricedBy: "manifest",
    });
    expect(usages[1]).toMatchObject({ reqId: "price-off", cost: 0.7, tier: "offPeak" });
    const usageEvents = evs.filter((e) => e.type === "MODEL_USAGE");
    expect(usageEvents.map((e) => e.schemaVersion)).toEqual([3, 3]);
    // 预扣 5 → 实结 1.4，退 3.6
    expect(pick(evs, "BUDGET_SETTLED")[0]).toMatchObject({ actual: 1.4, refund: 3.6 });
  });

  it("单次实结超预扣：用量如实、预算夹到限额、下一跳被 BUDGET/EXHAUSTED 拒", async () => {
    const scope = { agentId: "agent-overrun", sessionId: "sess-run-overrun" };
    const ref = { ...scope, runId: "run-overrun" };
    budget.configure(scope, { run: 0.5 });
    nowMs = OFF_PEAK;

    const first = await gateway.invoke(ref, scope.agentId, {
      reqId: "over-1",
      model: "mock-chat",
      params: {},
      estimate: 0.1,
    });
    expect(first.cost).toBe(0.7);

    const q = budget.query(ref);
    expect(q.run).toEqual({ limit: 0.5, used: 0.5, remaining: 0 }); // 夹到限额，不是 -0.2
    let evs = await readRun("run-overrun");
    expect(pick(evs, "BUDGET_SETTLED")[0]).toMatchObject({
      actual: 0.7,
      refund: -0.6,
      overrun: true,
    });
    // 计量如实：MODEL_USAGE 记的是 0.7，不是限额
    expect(pick(evs, "MODEL_USAGE")[0]).toMatchObject({ reqId: "over-1", cost: 0.7 });

    await expect(
      gateway.invoke(ref, scope.agentId, {
        reqId: "over-2",
        model: "mock-chat",
        params: {},
        estimate: 0.1,
      }),
    ).rejects.toMatchObject({ code: "BUDGET/EXHAUSTED" });

    evs = await readRun("run-overrun");
    expect(pick(evs, "MODEL_INVOKED")).toHaveLength(1); // 第二次连预扣都没过
    expect(pick(evs, "MODEL_USAGE")).toHaveLength(1);
  });

  it("机械对账：每条 MODEL_INVOKED 都有 MODEL_USAGE 或 BUDGET_SETTLED 收束（无未落账调用）", async () => {
    for (const runId of ["run-price", "run-overrun"]) {
      const evs = await readRun(runId);
      const invoked = evs.filter((e) => e.type === "MODEL_INVOKED").length;
      const settled = evs.filter(
        (e) => e.type === "MODEL_USAGE" || e.type === "BUDGET_SETTLED",
      ).length;
      expect(settled).toBeGreaterThanOrEqual(invoked);
      expect(evs.findIndex((e) => e.type === "MODEL_INVOKED")).toBeLessThan(
        evs.findIndex((e) => e.type === "MODEL_USAGE" || e.type === "BUDGET_SETTLED"),
      );
    }
  });
});

describe("D4：密钥红线（零值出现；引用名可诊断）", () => {
  it("账本文件、装配记录、事件载荷里没有任何密钥值", async () => {
    const files = (await readdir(dir, { recursive: true, withFileTypes: false })) as string[];
    const segments = files.filter((f) => f.endsWith(".jsonl"));
    expect(segments.length).toBeGreaterThan(0);
    for (const f of segments) {
      expect(await readFile(path.join(dir, f), "utf-8")).not.toContain(SECRET_VALUE);
    }
    const records = assembly.records as AssemblyRecordedPayload[];
    expect(JSON.stringify(records)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(await readRun("run-price"))).not.toContain(SECRET_VALUE);
    // 诊断只回引用名，不回值
    const modelPlugin = assembly.plugins.find((p) => p.kind === "model");
    expect(modelPlugin?.manifest.model?.auth.ref).toBe(SECRET_REF);
  });

  it("缺失密钥引用 = 拒绝装配，错误细节只写 ref 名", () => {
    const saved = process.env[SECRET_REF];
    delete process.env[SECRET_REF];
    try {
      const raw = JSON.parse(
        readFileSync(
          path.join(repoRoot, "packages", "plugins", "model-mock", "keel-plugin.json"),
          "utf-8",
        ),
      );
      let caught: unknown;
      try {
        new Assembler({ schema: manifestSchema }).assemble(raw);
      } catch (err) {
        caught = err;
      }
      const detail = (caught as { detail?: { ref?: string } }).detail;
      expect(detail?.ref).toBe(SECRET_REF);
      expect(JSON.stringify(caught)).not.toContain(saved ?? SECRET_VALUE);
    } finally {
      process.env[SECRET_REF] = saved ?? SECRET_VALUE;
    }
  });
});

describe("D6：超时与流中途失败的收束（已发部分永不悬空）", () => {
  it("上游抛 / 总时限到点 / 用量不按桶报：都先 settle 再报错", async () => {
    const ref = refOf("agent-fail", "run-fail");
    nowMs = OFF_PEAK;

    await expect(
      gateway.invoke(ref, "agent-fail", {
        reqId: "fail-throw",
        model: "mock-chat",
        params: { scenario: "throw" },
        estimate: 2,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY/UPSTREAM-ERROR" });

    await expect(
      gateway.invoke(ref, "agent-fail", {
        reqId: "fail-timeout",
        model: "mock-chat",
        params: { scenario: "slow", delayMs: 500 },
        estimate: 2,
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "INVOKE_TIMEOUT" },
    });

    await expect(
      gateway.invoke(ref, "agent-fail", {
        reqId: "fail-usage",
        model: "mock-chat",
        params: { scenario: "no-usage" },
        estimate: 2,
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "UPSTREAM_USAGE_INVALID" },
    });

    const evs = await readRun("run-fail");
    expect(pick(evs, "MODEL_INVOKED")).toHaveLength(3);
    expect(pick(evs, "MODEL_USAGE")).toHaveLength(0); // 三次都失败，没有可结算的完成调用
    expect(pick(evs, "BUDGET_SETTLED")).toHaveLength(3);
    expect(pick(evs, "BUDGET_SETTLED").every((p) => p.actual === 0)).toBe(true);
    expect(budget.query(ref).run.used).toBe(0); // 全额退还，不悬空
  });

  it("流式正常：终局按最后一组的累计三桶计价，分片不写事件", async () => {
    const ref = refOf("agent-stream", "run-stream");
    nowMs = OFF_PEAK;
    const page = await gateway.streamStart(ref, "agent-stream", {
      reqId: "stream-ok",
      model: "mock-chat",
      params: { chunks: 3 },
      estimate: 5,
    });
    expect(page.done).toBe(true);
    expect(page.produced).toBe(3);
    expect(page.cost).toBe(2.1); // 3 片 × 每片 0.7（累计桶 = 3M/3M/3M）

    const evs = await readRun("run-stream");
    expect(pick(evs, "MODEL_INVOKED")).toHaveLength(1);
    expect(pick(evs, "MODEL_USAGE")[0]).toMatchObject({
      reqId: "stream-ok",
      cost: 2.1,
      usageBuckets: {
        inputCached: 3_000_000,
        inputUncached: 3_000_000,
        output: 3_000_000,
      },
      tier: "offPeak",
      pricedBy: "manifest",
    });
    expect("truncated" in pick(evs, "MODEL_USAGE")[0]!).toBe(false);
    // 三片只留下结算这一条（账本体积不是流长度的函数）
    const from = evs.findIndex((e) => e.type === "MODEL_INVOKED");
    const to = evs.findIndex((e) => e.type === "MODEL_USAGE");
    expect(evs.slice(from + 1, to).map((e) => e.type)).toEqual(["BUDGET_SETTLED"]);
  });

  it("流中途抛：已产出两片结算、truncated:true、错误带 produced/金额", async () => {
    const ref = refOf("agent-boom", "run-boom");
    nowMs = OFF_PEAK;
    await expect(
      gateway.streamStart(ref, "agent-boom", {
        reqId: "stream-boom",
        model: "mock-chat",
        params: { chunks: 5, chunksBeforeThrow: 2 },
        estimate: 5,
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "STREAM_UPSTREAM_THROW", produced: 2, cost: 1.4 },
    });

    const evs = await readRun("run-boom");
    expect(pick(evs, "MODEL_USAGE")[0]).toMatchObject({
      reqId: "stream-boom",
      cost: 1.4,
      truncated: true,
    });
  });

  it("空闲看门狗（模块内，manifest idleMs）：停顿即中止并按断流结算", async () => {
    const ref = refOf("agent-idle", "run-idle");
    nowMs = OFF_PEAK;
    await expect(
      gateway.streamStart(ref, "agent-idle", {
        reqId: "stream-idle",
        model: "mock-chat",
        params: { chunks: 3, pauseAfterFirstMs: 500 },
        estimate: 5,
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "STREAM_UPSTREAM_THROW", produced: 1, cost: 0.7 },
    });
    const evs = await readRun("run-idle");
    expect(pick(evs, "MODEL_USAGE")[0]).toMatchObject({
      cost: 0.7,
      truncated: true,
    });
  });
});

describe("费用权威在 Core：模块自报 cost 与未注册模型都显式拒绝", () => {
  it("模块返回 cost → UPSTREAM_PROVIDED_COST，零结算、无 MODEL_USAGE", async () => {
    const local = new ModelGateway({
      ledger,
      auth,
      budget,
      upstream: stub,
      now: () => OFF_PEAK,
    });
    const pricing = assembly.plugins.find((p) => p.kind === "model")?.manifest.model?.pricing[
      "mock-chat"
    ];
    local.registerModel({
      models: ["cost-model"],
      upstream: { invoke: async () => ({ result: {}, usage: BUCKETS, cost: 9 }) },
      pricing: pricing!,
    });
    const ref = refOf("agent-cost", "run-cost");
    await expect(
      local.invoke(ref, "agent-cost", {
        reqId: "cost-1",
        model: "cost-model",
        params: {},
        estimate: 1,
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "UPSTREAM_PROVIDED_COST" },
    });
    const evs = await readRun("run-cost");
    expect(pick(evs, "MODEL_USAGE")).toHaveLength(0);
    expect(pick(evs, "BUDGET_SETTLED")[0]).toMatchObject({ actual: 0 });
  });

  it("profile 未注册的模型名 → MODEL_NOT_REGISTERED，不回落演示桩", async () => {
    const ref = refOf("agent-unknown", "run-unknown");
    await expect(
      gateway.invoke(ref, "agent-unknown", {
        reqId: "unknown-1",
        model: "not-installed",
        params: {},
        estimate: 1,
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "MODEL_NOT_REGISTERED" },
    });
  });
});

describe("R1/R3：表面事件族（ADR-0021）", () => {
  it("TURN_INPUT / MODEL_MESSAGE 进账本（v1），白名单只含三类，surfaceOp 形状预留", async () => {
    expect(SURFACE_EVENT_TYPES).toEqual(["TURN_INPUT", "MODEL_MESSAGE", "TOOL_RESULT"]);
    expect(isSurfaceEventType("TURN_INPUT")).toBe(true);
    expect(isSurfaceEventType("MODEL_MESSAGE")).toBe(true);
    expect(isSurfaceEventType("TOOL_RESULT")).toBe(true);
    expect(isSurfaceEventType("MODEL_USAGE")).toBe(false);
    expect(isSurfaceEventType("BUDGET_SETTLED")).toBe(false);

    const ref = refOf("agent-surface", "run-surface");
    const turn: TurnInputPayload = { role: "user", content: "hello" };
    await appendTurnInput(ledger, ref, turn);
    await appendModelMessage(ledger, ref, {
      content: "hi",
      reasoningContent: "weighing the answer",
      toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hi" } }],
      usageRef: { reqId: "surface-req" },
    });

    const evs = await readRun("run-surface");
    expect(evs.map((e) => e.type)).toEqual(["TURN_INPUT", "MODEL_MESSAGE"]);
    expect(evs.map((e) => e.schemaVersion)).toEqual([1, 1]);
    expect(evs[0]!.payload).toEqual(turn);
    expect(evs[1]!.payload).toMatchObject({
      content: "hi",
      reasoningContent: "weighing the answer",
      usageRef: { reqId: "surface-req" },
    });
  });
});
