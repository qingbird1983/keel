/**
 * 策略插件 → HookBus 的装配链（切片④，06 稿 §3.1；[ADR-0012](../../../../docs/adr/ADR-0012-policy-plugin-process-and-hook-op.md)）。
 *
 * 与 `wire-cell.test.ts` 同一姿态：用**内存隔离后端承载真实 Cell 进程体**（同进程 `startCell`
 * + 装载门），为的是把两条只能靠构造命中的路钉成确定性断言——"两份策略抢同一插话点"
 * 和"策略舱在自己 handler 里忙等"在真子进程下都要靠运气。
 * 真进程装载面（`policy-main` 只认 `export const hooks`）由
 * `packages/cell-runtime/test/policy-cell.test.ts` 负责；端到端归因由
 * `tests/policy-chain-attribution.test.ts`（B7①）负责。
 *
 * 本文件的主张只有四处：**注册集合 = 报关集合**、**抢同一插话点整份拒绝**、
 * **失败一律走内核既有 fallback（不新增错误码）**、**策略舱不归属 run（退出不级联，I2/F7）**。
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCell } from "@keel/cell-runtime";
import { HookBus, KeelError, Ledger, type LedgerEvent, type RunRef } from "@keel/core";
import type { CellProcess, IsolationProvider, SpawnSpec } from "../src/isolation.js";
import { CellSupervisor, type CellExit } from "../src/supervisor.js";
import { Assembler, type LoadedManifest } from "../src/assembler.js";
import { wirePolicies, type PolicySpec } from "../src/policy-link.js";

const schema = JSON.parse(
  readFileSync(path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json"), "utf-8"),
);
const POLICY_ENTRY = "mem://policy-main.js";
const scope = { agentId: "agent-p", sessionId: "sess-p" };
const ref: RunRef = { ...scope, runId: "run-p" };

function policyManifest(name: string, hooks: string[]): LoadedManifest {
  return new Assembler({ schema, contractVersion: "1.0.0" }).assemble({
    kind: "policy",
    meta: { name, version: "1.0.0", title: name, description: "d" },
    permissions: [],
    resources: {},
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
    hooks,
  });
}

function capabilityManifest(): LoadedManifest {
  return new Assembler({ schema, contractVersion: "1.0.0" }).assemble({
    kind: "capability",
    meta: { name: "cap-plug", version: "1.0.0", title: "C", description: "d" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
  });
}

/** 舱侧桩表：每个 hook 的应答形状由测试自己给（等价于策略模块 `export const hooks`）。 */
type VerdictTable = Record<string, (input: unknown) => unknown>;

const deny: VerdictTable = { toolApproval: () => ({ verdict: "deny", reason: "no" }) };
/** 忙等桩：比链路超时更久才答（用来证"先到期的是哪一层"）。 */
const busyMs = (ms: number): VerdictTable => ({
  toolApproval: () => new Promise((r) => setTimeout(() => r({ verdict: "deny" }), ms)),
});

/** 每舱的装载计划：桩表 + 是否开闸（`hold` = 策略模块没装载完，门永远不开）。 */
interface SpawnPlan {
  table: VerdictTable;
  hold?: boolean;
}

/** 内存后端：真实 Cell 进程体 + 装载门；开闸在 spawn 当下完成（与 policy-main 同次序）。 */
class PolicyProvider implements IsolationProvider {
  readonly specs: SpawnSpec[] = [];
  readonly procs: Proc[] = [];
  /** 由测试在装配前铺好（索引 = spawn 次序；越界 = 不开闸）。 */
  plan: SpawnPlan[] = [];

  spawn(spec: SpawnSpec): CellProcess {
    const hostToCell = new PassThrough();
    const cellToHost = new PassThrough();
    const handle = startCell({
      input: hostToCell,
      output: cellToHost,
      toolCallTimeoutMs: 0, // 策略舱没有工具时限这个量（F11）
      loadGate: true,
    });
    this.specs.push(spec);
    const proc = new Proc(cellToHost, hostToCell);
    this.procs.push(proc);
    // 装桩表 → 开闸（policy-main 就是这个次序：登记完才 markReady，未登记完不应答）
    const step = this.plan[this.procs.length - 1];
    if (step && !step.hold) {
      handle.setHooks(step.table);
      handle.markReady();
    }
    return proc;
  }

  /** bootstrap 里报关单声明的插话点（装载面据此把导出集合钉死，见 policy-main）。 */
  declared(i: number): string[] {
    return (JSON.parse(this.specs[i].bootstrap) as { hooks?: string[] }).hooks ?? [];
  }

  crash(i: number): void {
    this.procs[i].crash();
  }

  /** 宿主→舱方向发过的 op 名（按帧序；"就绪凭据是一次既有 op 的应答"的观测位）。 */
  ops(i: number): string[] {
    return this.procs[i].sent.map((line) => (JSON.parse(line) as { op?: string }).op ?? "");
  }
}

class Proc implements CellProcess {
  killed = false;
  /** 宿主写进来的每一帧（JSON 行）；用于 op 层面的断言。 */
  readonly sent: string[] = [];
  private code: number | null = null;
  private cbs: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  readonly stdin: { write(chunk: string): unknown };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr = null;

  constructor(toHost: PassThrough, fromHost: PassThrough) {
    this.stdin = {
      write: (c) => {
        for (const line of String(c).split("\n")) if (line.trim()) this.sent.push(line);
        return fromHost.write(c);
      },
    };
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
let bus!: HookBus;
let supervisor!: CellSupervisor;
let provider!: PolicyProvider;
let exits: CellExit[] = [];
let aborted: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-policy-"));
  ledger = new Ledger({ rootDir: dir });
  // HookBus 的超时**放大**（契约默认 200ms → 2s）：本文件要区分"链路自己的请求超时"
  // 与"内核 fallback"，只有内核时限更宽时先到期的才是链路那一层。
  bus = new HookBus(ledger, { timeoutMs: 2_000 });
  provider = new PolicyProvider();
  exits = [];
  aborted = [];
  supervisor = new CellSupervisor({
    provider,
    cellEntryPath: "mem://main.js",
    toolKillGraceMs: 500,
    onCellExit: (e) => {
      exits.push(e);
      // 生产宿主的 abort 缝就是这个形状（apps/keel/src/runtime.ts：`if (ref)`）
      if (e.cell.ref) aborted.push(e.cell.ref.runId);
    },
  });
});

afterEach(async () => {
  await Promise.allSettled(provider.procs.map((p) => (p.alive() ? p.kill() : undefined)));
  await ledger.close();
  await rm(dir, { recursive: true, force: true });
});

function spec(name: string, hooks: string[], modulePath = `mem://${name}.mjs`): PolicySpec {
  return { manifest: policyManifest(name, hooks), modulePath };
}

/** 铺好每舱的装载计划，再装配（开闸发生在 spawn 当下，不需要"先起后开"的编排）。 */
async function wire(
  specs: PolicySpec[],
  plan: SpawnPlan[],
  over: Partial<Parameters<typeof wirePolicies>[0]> = {},
) {
  provider.plan = plan;
  return wirePolicies({ supervisor, bus, specs, policyEntryPath: POLICY_ENTRY, ...over });
}

async function events(): Promise<LedgerEvent[]> {
  try {
    return (await ledger.read({ runId: ref.runId })).events;
  } catch {
    return [];
  }
}

describe("wirePolicies：注册集合 = 报关集合", () => {
  it("两份策略各申领不同插话点 → 只有申领过的注册了", async () => {
    const bindings = await wire(
      [spec("pol-approve", ["toolApproval"]), spec("pol-stop", ["stopAdvice"])],
      [{ table: deny }, { table: { stopAdvice: () => ({ suggestStop: true }) } }],
    );
    expect(bus.registered("toolApproval")).toBe(true);
    expect(bus.registered("stopAdvice")).toBe(true);
    expect(bus.registered("retryAdvice")).toBe(false); // 没申领 = 不注册（无介入即无事件）
    expect(bus.registered("budgetExhaustedChoice")).toBe(false);
    expect(bindings.map((b) => b.summary)).toEqual([
      { name: "pol-approve", version: "1.0.0", hooks: ["toolApproval"] },
      { name: "pol-stop", version: "1.0.0", hooks: ["stopAdvice"] },
    ]);
  });

  it("策略舱走策略入口，且报关单的 hooks 随 bootstrap 进舱（两张皮不起舱）", async () => {
    await wire([spec("pol-two", ["toolApproval", "stopAdvice"])], [{ table: deny }]);
    expect(provider.specs).toHaveLength(1);
    expect(provider.specs[0].entryPath).toBe(POLICY_ENTRY);
    expect(provider.declared(0)).toEqual(["toolApproval", "stopAdvice"]);
    expect(JSON.parse(provider.specs[0].bootstrap)).toMatchObject({
      pluginPath: "mem://pol-two.mjs",
      toolCallTimeoutMs: 0, // 不给策略舱造第二个时限数（F11）
    });
  });

  it("插话真的跨通道：verdict 来自舱内、非 fallback、账本留下 HOOK_CALLED + HOOK_VERDICT", async () => {
    await wire([spec("pol-approve", ["toolApproval"])], [{ table: deny }]);
    const res = await bus.call(ref, "toolApproval", 1, { tool: "x", paramsDigest: "p" });
    expect(res.verdict).toEqual({ verdict: "deny", reason: "no" });
    expect(res.fallback).toBe(false);
    expect(res.seqs).toHaveLength(2);
    expect((await events()).map((e) => e.type)).toEqual(["HOOK_CALLED", "HOOK_VERDICT"]);
  });

  it("就绪凭据 = 一次既有 op 的应答：装配期只发 cell.snapshot，不为策略方向加探测帧", async () => {
    await wire([spec("pol-approve", ["toolApproval"])], [{ table: deny }]);
    expect(provider.ops(0)).toEqual(["cell.snapshot"]); // 没有第二套握手（ADR-0011 同一姿态）
  });
});

describe("wirePolicies：装配期整份拒绝（ADR-0012 决策 5）", () => {
  it("两份策略抢同一插话点 → 明确拒绝，且什么都不起、什么都不注册", async () => {
    const err = (await wirePolicies({
      supervisor,
      bus,
      specs: [spec("pol-a", ["toolApproval"]), spec("pol-b", ["toolApproval"])],
      policyEntryPath: POLICY_ENTRY,
    }).catch((e: unknown) => e)) as KeelError;
    expect(err).toBeInstanceOf(KeelError);
    expect(err.code).toBe("SCHED/MANIFEST-INVALID");
    expect(err.message).toContain("toolApproval");
    expect(provider.specs).toHaveLength(0); // 不"先起一份再说"
    expect(bus.registered("toolApproval")).toBe(false); // 同名覆盖 = 静默改判，这里没有这条路
  });

  it("kind 不是 policy 的报关单 → 拒（策略接线不吃能力插件）", async () => {
    await expect(
      wirePolicies({
        supervisor,
        bus,
        specs: [{ manifest: capabilityManifest(), modulePath: "mem://cap.cjs" }],
        policyEntryPath: POLICY_ENTRY,
      }),
    ).rejects.toMatchObject({ code: "SCHED/MANIFEST-INVALID" });
    expect(provider.specs).toHaveLength(0);
  });

  it("白名单外的插话点 → 接线侧再挡一层（不依赖 schema 兜底）", async () => {
    // 绕过 schema 直接造一份"报关里混进 onToolCall"的产物，验证接线自己也知道白名单
    const bogus = { ...policyManifest("pol-bogus", ["toolApproval"]), hooks: ["onToolCall"] };
    await expect(
      wirePolicies({
        supervisor,
        bus,
        specs: [{ manifest: bogus, modulePath: "mem://bogus.mjs" }],
        policyEntryPath: POLICY_ENTRY,
      }),
    ).rejects.toMatchObject({ code: "SCHED/MANIFEST-INVALID" });
    expect(provider.specs).toHaveLength(0);
    expect(bus.registered("toolApproval")).toBe(false);
  });

  it("空 specs = 零起舱零注册（没策略是正常态，不是错误）", async () => {
    const bindings = await wirePolicies({
      supervisor,
      bus,
      specs: [],
      policyEntryPath: POLICY_ENTRY,
    });
    expect(bindings).toEqual([]);
    expect(provider.specs).toHaveLength(0);
  });
});

describe("wirePolicies：就绪与失败语义（不新增错误码）", () => {
  it("门未开（策略模块没装载完）→ TRANSPORT/TIMEOUT + CELL_NOT_READY，该舱被收掉", async () => {
    provider.plan = [{ table: deny, hold: true }];
    const done = wirePolicies({
      supervisor,
      bus,
      specs: [spec("pol-slow", ["toolApproval"])],
      policyEntryPath: POLICY_ENTRY,
      readyTimeoutMs: 200,
    });
    const err = (await done.catch((e: unknown) => e)) as KeelError;
    expect(err.code).toBe("TRANSPORT/TIMEOUT"); // 封闭集合内：探测未得到应答
    expect((err.detail as { reason: string }).reason).toBe("CELL_NOT_READY");
    expect((err.detail as { disposed: boolean }).disposed).toBe(true);
    expect(provider.procs[0].killed).toBe(true);
    expect(bus.registered("toolApproval")).toBe(false);
  });

  it("第二份策略起不来 → 已经起来的舱一并收干净，且一份 handler 都没留下", async () => {
    provider.plan = [{ table: deny }, { table: {}, hold: true }]; // 只开第一份的门
    const done = wirePolicies({
      supervisor,
      bus,
      specs: [spec("pol-ok", ["toolApproval"]), spec("pol-dead", ["stopAdvice"])],
      policyEntryPath: POLICY_ENTRY,
      readyTimeoutMs: 200,
    });
    await expect(done).rejects.toBeInstanceOf(KeelError);
    expect(provider.procs[0].alive()).toBe(false);
    expect(provider.procs[1].killed).toBe(true);
    expect(bus.registered("toolApproval")).toBe(false); // 注册是最后一步：半途失败 = 总线原样
  });
});

describe("wirePolicies：运行期失败一律走内核 fallback（I2：不级联 run）", () => {
  it("策略舱崩溃 → 插话得到 fallback:true，且没有任何 run 被 abort", async () => {
    const bindings = await wire([spec("pol-approve", ["toolApproval"])], [{ table: deny }]);
    expect((await bus.call(ref, "toolApproval", 1, {})).fallback).toBe(false);
    provider.crash(0);
    const res = await bus.call(ref, "toolApproval", 2, {});
    expect(res.fallback).toBe(true); // 通道断 = 默认策略，不抛进调度轮
    expect(res.verdict).toEqual({ verdict: "approve" });
    expect(
      (await events()).filter(
        (e) => e.type === "HOOK_VERDICT" && (e.payload as { fallback?: boolean }).fallback,
      ).length,
    ).toBe(1);
    // 策略舱不属于任何 run：它的退出不该触发 abort 缝（F7 的测试化）
    expect(bindings[0].cell.ref).toBeNull();
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.every((e) => e.cell.ref === null)).toBe(true);
    expect(aborted).toEqual([]);
  });

  it("策略忙等超过链路超时 → 链路先到期 → fallback，且不因一次慢插话强杀策略舱", async () => {
    await wire([spec("pol-busy", ["toolApproval"])], [{ table: busyMs(120) }], {
      hookTimeoutMs: 20,
    });
    const res = await bus.call(ref, "toolApproval", 1, {});
    expect(res.fallback).toBe(true);
    expect(res.verdict).toEqual({ verdict: "approve" });
    expect(provider.procs[0].alive()).toBe(true); // 时限只有一条：契约 §7 的 hook 预算
  });

  it("舱内漏登记这个 hook → 明确拒绝而非静默放行（归因指得到「没登记」）", async () => {
    // 报关申领了两个，桩表只登记一个：漏登记的那条必然失败，但仍是 fallback 而不是抛给调度轮
    await wire([spec("pol-partial", ["toolApproval", "stopAdvice"])], [{ table: deny }]);
    const stop = await bus.call(ref, "stopAdvice", 1, { round: 1 });
    expect(stop.fallback).toBe(true);
    expect(stop.verdict).toEqual({ suggestStop: false });
    const ok = await bus.call(ref, "toolApproval", 1, {});
    expect(ok.fallback).toBe(false); // 登记过的那条照常生效
  });
});
