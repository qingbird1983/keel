/**
 * 集成测试（真实进程 · 规模级）—— 验收 A1 主张（V1，一票否决）的测试化：
 * 20 个会话并发运行 + 轮间动态增删工具，逐条核对三件事：
 * ① 各 scope 工具表互不可见：每轮可见表恰好等于本会话自己的注册集（同名条目按 scope 各自记版本）；
 * ② 缓存命中率稳定：工具表指纹只在"自己动过"的那一轮变化——静止对照会话五轮指纹恒定
 *    （他域增删不造成本域失效 = 缓存键零扰动）；
 * ③ 无跨会话污染：TOOL_SCHEMA_CHANGED 只落受影响 scope 的 run 且条数等于自身增删次数、
 *    他域工具名零出现、每 run 事件归属纯净、全部会话正常收束。
 * 增删动作经 @keel/cordis-adapter 的旧框架形状 `ctx.tools.register()/remove()` 施加
 * （一域一份适配器实例），因此本测试同时回答两问：新内核不被全局注册污染，
 * 且旧写法迁入后仍然不被污染（Adapter 原型交付物 A 的实际承载面）。
 * 附带采集规模观测（并发 Cell 数 / 总耗时 / 宿主 RSS 增量）供 roadmap §4 隔离成本风险登记。
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
  HookBus,
  Ledger,
  ModelGateway,
  Scheduler,
  type LedgerEvent,
  type RunDriver,
  type RunRef,
  type RunStatus,
  type Scope,
  type ToolEntry,
} from "@keel/core";
import {
  Assembler,
  CellSupervisor,
  EffectTracker,
  ProcessIsolationProvider,
  SupervisedCell,
  serveCellChannel,
  type LoadedManifest,
} from "@keel/host";
import { createCordisCtx } from "@keel/cordis-adapter";

const repoRoot = process.cwd();
const cellEntry = path.join(repoRoot, "packages", "cell-runtime", "dist", "main.js");
const plugin = path.join(repoRoot, "tests", "fixtures", "ok-plugin.mjs");
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

/** 并发会话数（A1 口径 = 20；KEEL_A1_SESSIONS 仅供本机冒烟临时缩减）。 */
const SESSIONS = Number(process.env.KEEL_A1_SESSIONS ?? 20);
/** 每会话轮数（轮 1~4 执行动作，轮 5 收束）。 */
const ROUNDS = 5;
/** 每 5 个会话留 1 个静止对照会话：全程不增删工具，看它是否被邻居的变更波及。 */
const isStatic = (i: number): boolean => i % 5 === 0;

// 装载期静态发布经 tool.register 裁决（03 稿 §4，2026-11-03 切片②）：fixture 的 tools 导出
// 在舱装载时发布进本 scope 分区——规则必须来自报关单编译面（此处与无 allow 报关单等价）。
const policy = {
  version: "p1",
  allow: [
    { subject: "*", action: "tool.invoke", resource: "*" },
    { subject: "*", action: "tool.register", resource: "*" },
    { subject: "*", action: "tool.remove", resource: "*" },
  ],
};

const manifest: LoadedManifest = new Assembler({ schema: manifestSchema }).assemble({
  kind: "capability",
  meta: { name: "a1-demo", version: "1.0.0", title: "A1", description: "20 会话并发规模复演" },
  permissions: [{ cap: "tool.provide" }],
  resources: { toolCallTimeoutMs: 10_000 },
  compensation: { templates: [] },
  compat: { keelContract: "^1.0" },
});

/** 本会话私有工具名（全部带会话编号前缀：跨会话泄漏一眼可见）。 */
function toolNames(i: number): { base: string; alpha: string } {
  return { base: `s${i}-base`, alpha: `s${i}-alpha` };
}

/** 一个会话的观测结果：驱动内采集，测试末尾统一判定（不在驱动内抛错污染 run）。 */
interface Probe {
  scope: Scope;
  runId: string;
  /** 本会话一份适配器实例（旧框架 ctx 形状；作用域在构造期绑定，之后不可指定）。 */
  cordis: ReturnType<typeof createCordisCtx>;
  /** 每轮实际看到的工具表指纹。 */
  seen: string[][];
  /** 驱动内发现的违规描述（空 = 本会话一切符合预期）。 */
  violations: string[];
}

/** 指纹 = 可见工具表的稳定序列化（工具表缓存键的等价物）。 */
function fingerprint(entries: ToolEntry[]): string[] {
  return entries.map((t) => `${t.name}@${t.schemaVersion}`).sort();
}

let dir: string;
let ledger: Ledger;
let auth: Authorizer;
let budget: Budgeter;
let gateway: ModelGateway;
let ctxMgr: ContextManager;
let scheduler: Scheduler;
let supervisor: CellSupervisor;
const cells: SupervisedCell[] = [];
let rssBefore = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-a1-"));
  ledger = new Ledger({ rootDir: dir });
  auth = new Authorizer(policy, ledger);
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
      if (ref) void scheduler.abort(ref.runId, e.reasonCode, e.message);
    },
  });
  rssBefore = process.memoryUsage().rss;
});

afterAll(async () => {
  await Promise.allSettled(cells.map((c) => c.drainAndReap()));
  await ledger.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/* ── 每会话增删剧本（经 Cordis 适配器施加）───────────────────────────────
 * 开跑前（boot）注册 base + ok；轮内动作于下一轮生效：
 *   轮 1 → +alpha；轮 2 → −base；轮 3 → 同名再注册 ok（版本 1→2）；轮 4 → 无操作。
 * 静止对照会话全程不动（boot 两笔亦不动，其指纹五轮恒定）。
 */

/**
 * 每轮应有的可见表指纹（与剧本严格对应；03 稿 §4 后 boot 状态含静态发布）：
 * fixture 的静态 "ok" 在装载期发布 = v1，boot 重注册把它顶到 v2（静态/动态会话都有 boot）；
 * 动态会话剧本轮 3 再顶到 v3（轮 4 起可见）。静止对照会话剧本不动，boot 后恒定。
 */
function expectedFingerprint(i: number, round: number): string[] {
  const n = toolNames(i);
  const staticSet = isStatic(i);
  const okVersion = staticSet ? 2 : round >= 4 ? 3 : 2;
  const out = [`ok@${okVersion}`, `${n.base}@1`];
  if (!staticSet && round >= 2) out.push(`${n.alpha}@1`);
  if (!staticSet && round >= 3) out.splice(1, 1); // base 已下线
  return out.sort();
}

/** TOOL_SCHEMA_CHANGED 应有条数 = 静态发布 1 笔 + boot 两笔 + 动态会话剧本三笔。 */
function expectedChangeCount(i: number): number {
  return isStatic(i) ? 3 : 6;
}

function makeDriver(i: number, probe: Probe): RunDriver {
  const n = toolNames(i);
  return {
    decide: async (c) => {
      const got = fingerprint(c.tools);
      const want = expectedFingerprint(i, c.round);
      if (got.join(",") !== want.join(",")) {
        probe.violations.push(`round ${c.round}: visible ${got.join(",")} != ${want.join(",")}`);
      }
      const foreign = got.filter((e) => /^s\d+-/.test(e) && !e.startsWith(`s${i}-`));
      if (foreign.length > 0) {
        probe.violations.push(`round ${c.round}: foreign ${foreign.join(",")}`);
      }
      probe.seen.push(got);

      if (!isStatic(i)) {
        // 承接层端口与真实迁入路径同形（async）：注册是"跨进程问内核"的一次往返（02 稿 §6）
        if (c.round === 1)
          await probe.cordis.tools.register({ name: n.alpha, schema: { session: i } });
        if (c.round === 2) await probe.cordis.tools.remove(n.base);
        if (c.round === 3) await probe.cordis.tools.register({ name: "ok", schema: { bumped: i } });
      }
      if (c.round >= ROUNDS) return { done: true, summary: `s${i}-end` };
      return {
        summary: `s${i} r${c.round}`,
        actions: [{ kind: "tool", tool: "ok", params: { tag: i } }],
      };
    },
  };
}

async function startSession(i: number): Promise<{ probe: Probe; done: Promise<RunStatus> }> {
  const scope: Scope = { agentId: "agent-a1", sessionId: `sess-${String(i).padStart(2, "0")}` };
  const runId = `run-${String(i).padStart(2, "0")}`;
  const ref: RunRef = { ...scope, runId };
  const tracker = new EffectTracker({ ledger });
  const cell = supervisor.spawnCell({ manifest, pluginPath: plugin, tracker });
  cells.push(cell);
  serveCellChannel(
    cell.conn,
    {
      scope,
      ref,
      subject: scope.agentId,
      templates: new Map(manifest.templates.map((t) => [t.kind, t])),
    },
    { ledger, auth, budget, ctx: ctxMgr, gateway, tracker },
  );
  ctxMgr.alloc(scope);
  // 一域一份旧框架形状的 ctx：作用域在构造期绑定，之后注册调用没有"指定别域"的参数位
  const cordis = createCordisCtx({ ctx: ctxMgr, ref });
  const probe: Probe = { scope, runId, cordis, seen: [], violations: [] };
  const n = toolNames(i);
  // 静态发布是跨进程的异步帧（03 稿 §4，切片②起装载期发生）：boot 注册前等它落进本 scope
  // 分区，boot 状态才确定——否则"发布先到还是 boot 先到"是竞态，ok 的版本号不定（P-006）。
  {
    const t0 = Date.now();
    while (!ctxMgr.discover(ref).some((t) => t.name === "ok")) {
      if (Date.now() - t0 > 15_000) throw new Error("static publish did not land in partition");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  // 开跑前两笔注册（与原口径一致：先有自身注册集，再进第一轮决策）
  await Promise.all([
    cordis.tools.register({ name: n.base, schema: { session: i } }),
    cordis.tools.register({ name: "ok", schema: { session: i } }),
  ]);
  const { done } = scheduler.start({
    ref,
    subject: scope.agentId,
    executor: cell.executor,
    driver: makeDriver(i, probe),
    assembly: manifest.record,
  });
  cell.attachRun(ref);
  return { probe, done };
}

async function readRun(runId: string): Promise<LedgerEvent[]> {
  return (await ledger.read({ runId })).events;
}

describe(`A1（V1）：${SESSIONS} 会话并发 + 动态增删工具（真实进程规模级）`, () => {
  it("各 scope 工具表互不可见 / 指纹只因自身变更而变 / 无跨会话污染", async () => {
    const t0 = Date.now();
    const sessions = await Promise.all(Array.from({ length: SESSIONS }, (_, i) => startSession(i)));
    const statuses = await Promise.all(sessions.map((s) => s.done));
    const elapsedMs = Date.now() - t0;

    // 全部会话正常收束（崩溃或串话会让个别 run 落 failed）
    expect(statuses.every((s) => s.state === "halted" && s.rounds === ROUNDS)).toBe(true);

    // ① 可见表逐轮等于自身预期，且零他域条目
    expect(sessions.flatMap((s) => s.probe.violations)).toEqual([]);
    for (const s of sessions) {
      expect(s.probe.seen).toHaveLength(ROUNDS);
    }

    // ② 指纹扰动只来自自身增删
    const statics = sessions.filter((_, i) => isStatic(i));
    expect(statics.length).toBeGreaterThan(0);
    for (const s of statics) {
      expect(new Set(s.probe.seen.map((f) => f.join(","))).size).toBe(1);
    }
    for (const s of sessions.filter((_, i) => !isStatic(i))) {
      const changedAt = s.probe.seen
        .map((f, idx) => (idx > 0 && f.join(",") !== s.probe.seen[idx - 1].join(",") ? idx + 1 : 0))
        .filter((r) => r > 0);
      expect(changedAt).toEqual([2, 3, 4]);
    }

    // ③ 账本事实：归属纯净 + 变更事件条数/受影响 scope/工具名三重约束 + 工具回包无串话
    for (const [i, s] of sessions.entries()) {
      const evs = await readRun(s.probe.runId);
      expect(
        evs.every((e) => e.runId === s.probe.runId && e.sessionId === s.probe.scope.sessionId),
      ).toBe(true);

      const changes = evs.filter((e) => e.type === "TOOL_SCHEMA_CHANGED");
      expect(changes).toHaveLength(expectedChangeCount(i));
      for (const ch of changes) {
        const p = ch.payload as { tool: string; affectedScope: Scope | null };
        expect(p.affectedScope).toEqual(s.probe.scope);
        expect(p.tool === "ok" || p.tool.startsWith(`s${i}-`)).toBe(true);
      }

      const foreign = evs
        .map((e) => JSON.stringify(e.payload))
        .filter((t) => /"s\d+-(base|alpha)"/.test(t) && !t.includes(`"s${i}-`));
      expect(foreign).toEqual([]);

      const results = evs.filter((e) => e.type === "TOOL_RESULT");
      expect(results).toHaveLength(ROUNDS - 1);
      expect(
        results.every((e) => {
          const d = (e.payload as { resultDigest?: { echoed?: { tag?: number } } }).resultDigest;
          return d?.echoed?.tag === i;
        }),
      ).toBe(true);
    }

    // 规模观测（供 roadmap §4 风险登记，非阈值断言）
    const totalEvents = (await Promise.all(sessions.map((s) => readRun(s.probe.runId)))).reduce(
      (n, e) => n + e.length,
      0,
    );
    const rssDeltaMb = Math.max(0, Math.round((process.memoryUsage().rss - rssBefore) / 2 ** 20));
    console.info(
      `[A1] sessions=${SESSIONS} cells=${cells.length} rounds=${ROUNDS} events=${totalEvents} ` +
        `elapsed=${elapsedMs}ms hostRssDelta=${rssDeltaMb}MiB`,
    );
  }, 180_000);
});
