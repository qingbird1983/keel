/**
 * 集成测试（真实进程）—— 验收 A7 主张的"实测"补执行：
 * Cell 内没有任何直连模型的路径，四条路径全在真实进程 + 真实通道上跑一遍：
 * ① 越权工具授权查询 → 授权器默认拒绝（allowed:false）且 AUTH_DENIED 留痕；
 * ② 越权模型调用 → 网关在预扣之前即拒（AUTH/DENIED 抛回 Cell），账本无 BUDGET_RESERVED、
 *    无 MODEL_INVOKED，上游一次也没被打（fail-closed 不是"先打了再说"）；
 * ③ 合法模型调用 → 只能经网关：预扣 → 代理 → 权威计量实结（差额退还）+ MODEL_USAGE；
 * ④ 同 reqId 重放 → replay=true、不重打上游、不重复计费（预算权威记账）。
 */

import { execSync } from "node:child_process";
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
  type AuthDeniedPayload,
  type LedgerEvent,
  type RunDriver,
  type RunRef,
  type Scope,
  type ToolResultPayload,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  EffectTracker,
  ProcessIsolationProvider,
  SupervisedCell,
  serveCellChannel,
} from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const plugin = path.join(repoRoot, "tests", "fixtures", "fail-closed-plugin.mjs");
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

const RUN = "run-a7";
/** 只放行 probe-paths 与 gpt-mini：Cell 自查越权工具、越权模型都必然走拒绝支（契约 §4.2 fail-closed）。 */
const policy = {
  version: "p-a7",
  allow: [
    { subject: "*", action: "tool.invoke", resource: "probe-paths" },
    { subject: "*", action: "model.invoke", resource: "gpt-mini" },
  ],
};

const manifest = new Assembler({ schema: manifestSchema }).assemble({
  kind: "capability",
  meta: { name: "a7-demo", version: "1.0.0", title: "A7", description: "网关唯一通道实测" },
  permissions: [{ cap: "tool.provide" }],
  resources: { toolCallTimeoutMs: 10_000 },
  compensation: { templates: [] },
  compat: { keelContract: "^1.0" },
});

let dir = "";
let ledger: Ledger;
let cell: SupervisedCell;
let events: LedgerEvent[] = [];
let upstreamCalls = 0;
let digest: Record<string, unknown> = {};

beforeAll(() => {
  execSync("pnpm --filter @keel/cell-runtime build", { cwd: repoRoot, stdio: "pipe" });
});

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-a7-"));
  ledger = new Ledger({ rootDir: dir });
  const auth = new Authorizer(policy, ledger);
  const budget = new Budgeter(ledger);
  const ctxMgr = new ContextManager();
  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: {
      invoke: async () => {
        upstreamCalls += 1;
        return { result: { text: `up#${upstreamCalls}` }, usage: { tokens: 12 }, cost: 60 };
      },
    },
  });
  const scheduler = new Scheduler({
    ledger,
    auth,
    budget,
    ctx: ctxMgr,
    hooks: new HookBus(ledger),
    gateway,
  });
  const supervisor = new CellSupervisor({
    provider: new ProcessIsolationProvider(),
    cellEntryPath: cellEntry,
    toolKillGraceMs: 5_000,
    onCellExit: (e) => {
      const ref = e.cell.ref;
      if (ref) void scheduler.abort(ref.runId, e.reasonCode, e.message);
    },
  });

  const scope: Scope = { agentId: "agent-a7", sessionId: "sess-a7" };
  const ref: RunRef = { ...scope, runId: RUN };
  const tracker = new EffectTracker({ ledger });
  cell = supervisor.spawnCell({ manifest, pluginPath: plugin, tracker });
  serveCellChannel(
    cell.conn,
    {
      scope,
      ref,
      subject: "agent-a7",
      templates: new Map(manifest.templates.map((t) => [t.kind, t])),
    },
    { ledger, auth, budget, ctx: ctxMgr, gateway, tracker },
  );
  ctxMgr.alloc(scope);
  budget.configure(scope, { run: 1000 });

  const driver: RunDriver = {
    decide: async (c) =>
      c.round === 1
        ? { summary: "probe", actions: [{ kind: "tool", tool: "probe-paths", params: {} }] }
        : { done: true, summary: "a7-end" },
  };
  const { done } = scheduler.start({
    ref,
    subject: "agent-a7",
    executor: cell.executor,
    driver,
    assembly: manifest.record,
  });
  cell.attachRun(ref);
  const status = await done;
  expect(status).toMatchObject({ state: "halted", rounds: 2 });

  const cold = new Ledger({ rootDir: dir });
  try {
    events = (await cold.read({ runId: RUN })).events;
  } finally {
    await cold.close();
  }
  const toolResult = events.find((e) => e.type === "TOOL_RESULT") as LedgerEvent;
  digest = (toolResult.payload as ToolResultPayload).resultDigest as Record<string, unknown>;
  await cell.drainAndReap();
  await ledger.close();
  console.info(
    `[A7] upstreamCalls=${upstreamCalls} authDenied=${
      events.filter((e) => e.type === "AUTH_DENIED").length
    } reserved=${events.filter((e) => e.type === "BUDGET_RESERVED").length} ` +
      `settled=${events.filter((e) => e.type === "BUDGET_SETTLED").length} digest=${JSON.stringify(
        digest,
      )}`,
  );
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const ofType = (t: string): LedgerEvent[] => events.filter((e) => e.type === t);

describe("A7：预算权威记账 + Cell 直连路径 fail-closed（真实进程）", () => {
  it("① 越权工具授权查询：拒绝且留痕", () => {
    expect(digest.toolAllowed).toBe(false);
    const denied = ofType("AUTH_DENIED").map((e) => e.payload as AuthDeniedPayload);
    expect(denied).toContainEqual(
      expect.objectContaining({
        subject: "agent-a7",
        action: "tool.invoke",
        resource: "forbidden-tool",
        policyVersion: "p-a7",
      }),
    );
  });

  it("② 越权模型调用：预扣之前即拒，无预留、无调用痕迹、上游零打扰", () => {
    expect(digest.modelDeniedCode).toBe("AUTH/DENIED");
    expect(
      ofType("AUTH_DENIED")
        .map((e) => e.payload)
        .filter((p) => (p as AuthDeniedPayload).action === "model.invoke"),
    ).toHaveLength(1);
    expect(ofType("BUDGET_RESERVED").map((e) => (e.payload as { reqId: string }).reqId)).toEqual([
      "a7-good",
    ]);
    expect(ofType("MODEL_INVOKED").map((e) => (e.payload as { reqId: string }).reqId)).toEqual([
      "a7-good",
    ]);
  });

  it("③④ 合法调用经网关：预扣 100 → 实结 60 退 40，同 id 重放不重打上游不重复计费", () => {
    const good = digest.good as { cost: number; usage: unknown; replay: boolean };
    const again = digest.again as { cost: number; replay: boolean };
    expect(good).toMatchObject({ cost: 60, usage: { tokens: 12 }, replay: false });
    expect(again).toMatchObject({ cost: 60, replay: true });
    expect(upstreamCalls).toBe(1); // 重放命中网关幂等缓存
    expect(ofType("BUDGET_RESERVED")).toHaveLength(1);
    expect(ofType("BUDGET_SETTLED")).toHaveLength(1);
    expect(ofType("BUDGET_SETTLED")[0]?.payload).toMatchObject({ actual: 60, refund: 40 });
    expect(ofType("MODEL_USAGE")).toHaveLength(1);
    expect(ofType("MODEL_USAGE")[0]?.payload).toMatchObject({ reqId: "a7-good", cost: 60 });
    console.info(
      `[A7] 权威记账：预扣 100 / 实结 60 / 退还 40，上游共 ${upstreamCalls} 次（重放未打）`,
    );
  });
});
