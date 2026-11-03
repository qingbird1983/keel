/**
 * 集成测试（真实子进程）—— Phase 2 验收 **B6**：存量插件的升级走同一条 V5 链（03 稿 §5）。
 *
 * 这里补的是开工事实 F3 那道缝：**装配编排（AssemblyManager）与运行通道（serveCellChannel）此前
 * 是两条不相交的线**——`cmd-hotswap` 因此从不发起 run，也就从没观察过"换绑之后的新舱能不能用"。
 * 本文件用 `wireCell()` 作为 CellFactory（起舱 → 绑通道 → 建分区 → 就绪探测一次做完），
 * 于是"换绑后 run 真跑"这条主张第一次被真的跑出来，而不是写在文档里。
 *
 * 断言两条（合同 §5 B6）：
 * ① 无 `migration` 的旧插件成功原子换绑：`replacesVersion` 留痕、新舱把同名工具顶到 v2、
 *    **换绑后这个 run 真的跑通**（新实现返回 v2，新增工具可见可执行）；
 * ② 声明 `migration` 的旧插件当场回退：承接层不代旧插件实现迁移钩 → 首个 `cell.migrate` 拿
 *    `CELL/MIGRATION-MISSING`（03 稿 §5 明文），绑定表回到旧版本、旧舱照常可 run。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LedgerEvent, RunDriver, RunRef, Scope } from "@keel/core";
import {
  Assembler,
  AssemblyManager,
  wireCell,
  type CellFactory,
  type LoadedManifest,
  type ManagedCell,
  type WiredCell,
} from "@keel/host";
import {
  assembleManifest,
  buildRuntime,
  closeRuntime,
  cordisCellEntryPath,
  loadSchema,
  readRun,
  runPolicy,
  type Runtime,
} from "../apps/keel/src/runtime.js";
import { fixtureFile } from "./fixtures/cordis-rig";

const AGENT = "agent-b6";
const scope: Scope = { agentId: AGENT, sessionId: "sess-b6" };
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-b6-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function results(events: LedgerEvent[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.type === "TOOL_RESULT")
    .map((e) => e.payload as Record<string, unknown>);
}

function digestOf(events: LedgerEvent[], tool: string): unknown {
  const hit = results(events)
    .reverse()
    .find((p) => p.tool === tool);
  return hit?.resultDigest;
}

/** 读趟内账本；未知 run = 空（回退路径的主张正是"这个 run 从没发生过"）。 */
async function safeReadRun(rt: Runtime, runId: string): Promise<LedgerEvent[]> {
  try {
    return await readRun(rt, runId);
  } catch {
    return [];
  }
}

function visible(rt: Runtime): string[] {
  return rt.ctx
    .discover(scope)
    .map((t) => `${t.name}@${t.schemaVersion}`)
    .sort();
}

/** 旧插件的报关单（B6 用两份版本；migration 只在回退那份出现）。 */
function legacyRaw(version: string, allow: string[], migration: boolean): unknown {
  return {
    kind: "capability",
    meta: { name: "legacy-flip", version, title: "flip", description: "B6 升级路径样本" },
    permissions: [{ cap: "tool.provide", allow }],
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
    ...(migration
      ? {
          migration: {
            from: "^1.0",
            steps: [{ to: version, action: { type: "hook", ref: "migrate" } }],
          },
        }
      : {}),
  };
}

/** 被编排的舱 = `wireCell()` 的产物：绑定表要的是 ManagedCell，运行要的是 SupervisedCell。 */
interface WiredManaged extends ManagedCell {
  ref: RunRef;
  wired: Promise<WiredCell>;
}

/**
 * 装配编排的工厂：spawn 出去就把手伸进通道（F3 的消解形态）。
 * spawn 是同步契约，就绪探测是异步的——promise 存下来，run 前 await。
 */
function wiringFactory(rt: Runtime, runIds: string[]) {
  const made: WiredManaged[] = [];
  let i = 0;
  const factory: CellFactory = {
    spawn: (spec) => {
      const ref = { ...scope, runId: runIds[i++] };
      const wired = wireCell({
        supervisor: rt.supervisor,
        deps: {
          ledger: rt.ledger,
          auth: rt.auth,
          budget: rt.budget,
          ctx: rt.ctx,
          gateway: rt.gateway,
        },
        scope,
        ref,
        subject: AGENT,
        manifest: spec.manifest,
        pluginPath: spec.pluginPath,
        cellEntry: spec.cellEntry,
      });
      wired.catch(() => undefined); // 失败由调用方的 await 报出，不留浮空拒绝
      const handle: WiredManaged = {
        ref,
        wired,
        migrate: async (oldState) => (await wired).cell.migrate(oldState),
        dispose: async () => {
          await wired.then((w) => w.cell.drainAndReap()).catch(() => undefined);
        },
      };
      made.push(handle);
      return handle;
    },
  };
  return { factory, made };
}

/** 分区是宿主自己的内存态：等旧舱 fire-and-forget 的注册落定（03 稿 §12 限制 7）。 */
async function awaitVisible(rt: Runtime, want: string[]): Promise<string[]> {
  const t0 = Date.now();
  for (;;) {
    const got = visible(rt);
    if (want.every((n) => got.some((g) => g.split("@")[0] === n))) return got;
    if (Date.now() - t0 > 10_000) throw new Error(`tools not visible: want ${want}, got ${got}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 在"这个舱"上起一次 run：工具按名逐个调用（表由插件自己的注册填出来，不是测试造数）。 */
async function runOn(rt: Runtime, h: WiredManaged, manifest: LoadedManifest, tools: string[]) {
  const { cell } = await h.wired;
  const queue = [...tools];
  const driver: RunDriver = {
    decide: async () => {
      const tool = queue.shift();
      if (tool === undefined) return { done: true, summary: "b6-end" };
      return { summary: `b6 call ${tool}`, actions: [{ kind: "tool", tool, params: {} }] };
    },
  };
  const { done } = rt.scheduler.start({
    ref: h.ref,
    subject: AGENT,
    executor: cell.executor,
    driver,
    assembly: manifest.record,
  });
  cell.attachRun(h.ref);
  const status = await done;
  return { status, events: await readRun(rt, h.ref.runId) };
}

describe("B6①：无迁移声明的旧插件——原子换绑后 run 真跑", () => {
  it("v1 跑通 → 换绑 v2（replacesVersion 留痕）→ 新舱的同名工具顶到 v2 且新工具可见可执行", async () => {
    const v1 = assembleManifest(legacyRaw("1.0.0", ["flip"], false));
    const v2 = assembleManifest(legacyRaw("1.1.0", ["flip", "extra"], false));
    // 策略 = 报关单编译（§4 第 2 条）。升级窗口内两版都在册，故取两版名字的上界（v2 ⊇ v1）
    const rt = await buildRuntime(path.join(dir, "swap"), { policy: runPolicy(v2, AGENT, "p-b6") });
    const { factory, made } = wiringFactory(rt, ["b6-v1", "b6-v2"]);
    const manager = new AssemblyManager({
      assembler: new Assembler({ schema: loadSchema() }),
      factory,
    });
    try {
      manager.bind(scope, {
        manifest: v1,
        pluginPath: fixtureFile("tierB-04-v1.cjs"),
        cellEntry: cordisCellEntryPath,
      });
      expect(await awaitVisible(rt, ["flip"])).toEqual(["flip@1"]);

      const first = await runOn(rt, made[0], v1, ["flip"]);
      expect(first.status.state).toBe("halted");
      expect(digestOf(first.events, "flip")).toEqual({ v: 1, from: "legacy-v1" });

      // ── 原子换绑：校验 → 新舱 → （无迁移钩）→ 换绑 ─────────────────────────
      const { record } = await manager.hotSwap(scope, {
        rawManifest: legacyRaw("1.1.0", ["flip", "extra"], false),
        pluginPath: fixtureFile("tierB-04-v2.cjs"),
        cellEntry: cordisCellEntryPath,
      });
      expect(record.manifest.version).toBe("1.1.0");
      expect(record.replacesVersion).toBe("1.0.0"); // V5 留痕
      expect(manager.current(scope)?.manifest.meta.version).toBe("1.1.0");
      await made[0].dispose(); // 旧舱由调用方收束（V5：换绑后 drain）

      // 新舱把 flip 顶到 v2（ADR-0010 同名再注册 = 版本 +1），并多出一个 extra
      expect(await awaitVisible(rt, ["flip", "extra"])).toEqual(["extra@1", "flip@2"]);

      // **F3 的正面主张**：换绑后的通道是服务着的，run 真的能跑，跑的是新实现
      const second = await runOn(rt, made[1], v2, ["flip", "extra"]);
      expect(second.status.state).toBe("halted");
      expect(digestOf(second.events, "flip")).toEqual({ v: 2, from: "legacy-v2" });
      expect(digestOf(second.events, "extra")).toEqual({ tool: "extra" });
      expect(second.events.filter((e) => e.type === "AUTH_DENIED")).toEqual([]);
    } finally {
      await Promise.allSettled(made.map((h) => h.dispose()));
      await closeRuntime(rt);
    }
  }, 180_000);
});

describe("B6②：声明迁移的旧插件——首个迁移调用即回退，旧绑定原样", () => {
  it("新舱拿 CELL/MIGRATION-MISSING 当场丢弃，绑定表停在 1.0.0，旧舱的 run 照跑", async () => {
    const v1 = assembleManifest(legacyRaw("1.0.0", ["flip"], false));
    const v2 = assembleManifest(legacyRaw("1.1.0", ["flip", "extra"], true));
    // 权限面给到两版名字的上界：本条要测的是"迁移钩缺失 → 回退"，不是"多声明被拒"。
    // 用旧报关单的话，新舱的 extra 会被当场拒 → 未决拒绝 → 舱崩，于是同一个舱里并存两条失败，
    // 谁先到达是不确定的（本地 Windows 先拿到 migrate 错误，CI 的 Linux 先拿到通道断）——
    // 一条测试只留一个失败原因，另一个用策略排除。"多声明被拒"在 B2③ 已单独硬测。
    const rt = await buildRuntime(path.join(dir, "rollback"), {
      policy: runPolicy(v2, AGENT, "p-b6-rollback"),
    });
    const { factory, made } = wiringFactory(rt, ["b6-r-v1", "b6-r-v2"]);
    const manager = new AssemblyManager({
      assembler: new Assembler({ schema: loadSchema() }),
      factory,
    });
    try {
      manager.bind(scope, {
        manifest: v1,
        pluginPath: fixtureFile("tierB-04-v1.cjs"),
        cellEntry: cordisCellEntryPath,
      });
      await awaitVisible(rt, ["flip"]);

      // 旧插件不导出 migrate（那是新生态形状），承接层也不代它实现 → 首个 cell.migrate 即失败
      const err = await manager
        .hotSwap(scope, {
          rawManifest: legacyRaw("1.1.0", ["flip", "extra"], true),
          pluginPath: fixtureFile("tierB-04-v2.cjs"),
          cellEntry: cordisCellEntryPath,
        })
        .catch((e) => e as { code?: string; detail?: { cause?: string } });
      expect((err as { code?: string }).code).toBe("SCHED/MANIFEST-INVALID");
      expect(String((err as { detail?: { cause?: string } }).detail?.cause)).toContain(
        "CELL/MIGRATION-MISSING",
      );

      // 回退主张：绑定表回到旧版本；被丢弃的新舱没起过 run，账本里一条痕迹都没有
      expect(manager.current(scope)?.manifest.meta.version).toBe("1.0.0");
      expect(await safeReadRun(rt, "b6-r-v2")).toEqual([]);

      // 如实记录一条**没被回收**的副作用：被丢弃的新舱在 activation 里把 flip 顶到了 v2、
      // 并挂上了 extra，分区留着这两笔，而执行体仍是旧舱——
      // "回退不回收分区注册"是本片的真实边界（03 稿 §12 限制 8）
      expect(visible(rt)).toEqual(["extra@1", "flip@2"]);

      // 旧舱照旧能用——回退不是"把会话搞坏"，是"这次升级没发生"
      const again = await runOn(rt, made[0], v1, ["flip"]);
      expect(again.status.state).toBe("halted");
      expect(digestOf(again.events, "flip")).toEqual({ v: 1, from: "legacy-v1" });
    } finally {
      await Promise.allSettled(made.map((h) => h.dispose()));
      await closeRuntime(rt);
    }
  }, 180_000);
});
