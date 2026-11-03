/**
 * 集成测试（真实进程）—— R4 生命周期（ADR-0017）：setup / 资源 effect / dispose。
 *
 * L1 setup 期登记的动态工具进入本 scope 可见表（与静态工具并列）；
 * L2 cell.dispose 先跑模块 dispose，再按 LIFO 跑资源 effect；重复调用幂等；
 * L3 drainAndReap 走同一路径（正常收尾），不因 dispose 失败卡住 reaped。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Authorizer,
  Budgeter,
  ContextManager,
  Ledger,
  ModelGateway,
  type RunRef,
  type Scope,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  ProcessIsolationProvider,
  manifestAuthRules,
  wireCell,
  type LoadedManifest,
} from "@keel/host";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const pluginPath = path.join(repoRoot, "tests", "fixtures", "lifecycle-plugin.mjs");
const manifestPath = path.join(repoRoot, "tests", "fixtures", "lifecycle-plugin.json");
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
let supervisor: CellSupervisor;
let manifest: LoadedManifest;
const cells: { drainAndReap(): Promise<unknown> }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-lifecycle-"));
  ledger = new Ledger({ rootDir: dir });
  ctxMgr = new ContextManager();
  budget = new Budgeter(ledger);
  manifest = new Assembler({ schema: JSON.parse(readFileSync(schemaPath, "utf-8")) }).assemble(
    JSON.parse(readFileSync(manifestPath, "utf-8")),
  );
  auth = new Authorizer(
    {
      version: "p-lifecycle",
      allow: [
        ...manifestAuthRules(manifest, "agent-a"),
        { subject: "agent-a", action: "tool.invoke", resource: "*" },
      ],
    },
    ledger,
  );
  gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: { invoke: async () => ({ result: {}, usage: { tokens: 0 }, cost: 0 }) },
  });
  supervisor = new CellSupervisor({
    provider: new ProcessIsolationProvider(),
    cellEntryPath: cellEntry,
    toolKillGraceMs: 2_000,
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

describe("R4：插件生命周期（真实进程）", () => {
  it("setup 动态工具可见；dispose 先模块后资源，重复调用幂等", async () => {
    const scope: Scope = { agentId: "agent-a", sessionId: "sess-life" };
    const { ref, cell } = await wire(scope, "run-life");

    // L1：静态 noop + setup 期 dynamic_echo 都在本 scope 可见表
    expect(ctxMgr.discover(ref).map((t) => t.name)).toEqual(["dynamic_echo", "noop"]);
    // 动态工具真的可执行（发布链路不是空壳）
    const exec = await cell.executor({ tool: "dynamic_echo", params: { text: "hi" } });
    expect(exec).toMatchObject({ status: "ok", result: { echo: "hi" } });

    // L2：dispose 前 started、未 disposed、无清理顺序
    expect(await cell.pullSnapshot()).toMatchObject({
      started: true,
      disposed: false,
      order: [],
    });
    await cell.call("cell.dispose", {}, 3_000);
    expect(await cell.pullSnapshot()).toMatchObject({
      started: true,
      disposed: true,
      order: ["dispose", "effect"],
    });
    // 幂等：第二次不重复执行清理
    await cell.call("cell.dispose", {}, 3_000);
    expect(await cell.pullSnapshot()).toMatchObject({ order: ["dispose", "effect"] });
  });
});
