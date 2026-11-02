/**
 * 集成测试（真实子进程）—— 运行期注册通道自身的语义与证据面（02 稿 §5、§8 第三行）。
 *
 * 与 tier-a 测试的分工：那边证"迁入能用"（B1 三主张），这边证"通道守规矩"——
 * 拒绝留痕的载荷齐不齐、handler 有没有出舱、换入口影不影响隔离、反复增删会不会漂。
 */

import { execSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEvent } from "@keel/core";
import {
  createLegacyRig,
  coreFixtureFile,
  fixtureFile,
  legacyManifest,
  policyFor,
  repoRoot,
} from "./fixtures/cordis-rig";

const AGENT = "agent-chan";
let rig: ReturnType<typeof createLegacyRig>;

beforeAll(() => {
  execSync("pnpm build", { cwd: repoRoot, stdio: "pipe" });
}, 120_000);

beforeEach(async () => {
  rig = createLegacyRig();
  await rig.setup(policyFor(legacyManifest(), AGENT));
});
afterEach(async () => {
  await rig.close();
});

function pick(events: LedgerEvent[], type: string): Record<string, unknown>[] {
  return events.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
}

/** 真正"被点名且跑成功"的工具名（TOOL_INVOKE ∩ status:"ok" 的 TOOL_RESULT），按发生顺序。 */
function okInvoked(events: LedgerEvent[]): string[] {
  const ok = new Set(
    pick(events, "TOOL_RESULT")
      .filter((p) => p.status === "ok")
      .map((p) => String(p.tool)),
  );
  return pick(events, "TOOL_INVOKE")
    .map((p) => String(p.tool))
    .filter((t) => ok.has(t));
}

describe("注册通道的授权面：拒绝必须留痕且不写任何一半状态", () => {
  it("AUTH_DENIED 载荷五要素齐（谁 × 做什么 × 对哪个工具 × 哪版策略 × 为什么）", async () => {
    const strict = createLegacyRig();
    await strict.setup([{ subject: "*", action: "tool.invoke", resource: "*" }]);
    try {
      const probe = strict.runLegacy({
        agentId: AGENT,
        sessionId: "sess-deny",
        runId: "run-deny",
        pluginPath: fixtureFile("neg-undeclared.cjs"),
        caps: [],
        // 屏障等到"舱退出"为止：run 必须活着经历这次崩溃，RUN_FAILED 才是这个 run 的
        boot: ["should-not-appear"],
        plan: [{ done: true }],
      });
      expect((await probe.done).state).toBe("failed");

      const ev = await strict.readRun("run-deny");
      const denied = pick(ev, "AUTH_DENIED");
      expect(denied.length).toBeGreaterThan(0);
      expect(denied[0]).toMatchObject({
        subject: AGENT,
        action: "tool.register",
        resource: "should-not-appear",
        policyVersion: "p-b1",
      });
      expect(String(denied[0].reason)).toContain("no allow rule matches");
      // 拒绝的登记在可见分区里不存在（内核侧从未写进），run 里也没有它的执行痕迹
      expect(pick(ev, "TOOL_SCHEMA_CHANGED")).toEqual([]);
      expect(strict.ctx.discover(probe.ref).map((t) => t.name)).toEqual([]);
      expect(ev.some((e) => e.type === "TOOL_INVOKE")).toBe(false);
    } finally {
      await strict.close();
    }
  }, 60_000);

  it("注册只传播名字与版本，schema 实体与 handler 都不进账本（handler 永不出舱的直接证据）", async () => {
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-leak",
      runId: "run-leak",
      pluginPath: fixtureFile("tierA-01-toolset.cjs"),
      plan: [
        { visible: ["echo", "sum", "tag"], call: { tool: "echo", params: { q: 1 } } },
        { done: true },
      ],
    });
    await probe.done;
    const ev = await rig.readRun("run-leak");
    const changes = pick(ev, "TOOL_SCHEMA_CHANGED");
    expect(changes).toHaveLength(3);
    for (const c of changes) {
      expect(Object.keys(c).sort()).toEqual([
        "affectedScope",
        "newSchemaVersion",
        "oldSchemaVersion",
        "tool",
      ]);
    }
    // 账本里没有任何 handler 文本或 schema 实体（执行体与形状都留在舱内）
    const dump = JSON.stringify(changes);
    expect(dump).not.toContain("type");
    expect(dump).not.toContain("object");
  }, 60_000);
});

describe("seam：换 Cell 入口不改隔离与生命周期语义", () => {
  it("同一 supervisor 同时承载新生态插件与旧形状插件，各自正常收束", async () => {
    const modern = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-modern",
      runId: "run-modern",
      // 新生态形状：export const tools（默认入口装载进执行表）。注意它**不经通道注册**，
      // 所以可见表是空的（F1 的现状）——这里只对照"入口可混用、生命周期同源"，不主张它的可见性。
      pluginPath: coreFixtureFile("modern-peer.mjs"),
      entry: "default",
      plan: [{ call: { tool: "m-echo", params: { v: 1 } } }, { done: true }],
    });
    const legacy = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-legacy",
      runId: "run-legacy",
      pluginPath: fixtureFile("tierA-01-toolset.cjs"),
      plan: [
        { visible: ["echo", "sum", "tag"], call: { tool: "sum", params: { a: 5, b: 5 } } },
        { done: true },
      ],
    });
    const [sm, sl] = await Promise.all([modern.done, legacy.done]);

    expect([sm.state, sl.state]).toEqual(["halted", "halted"]);
    expect(legacy.violations).toEqual([]);
    // 默认入口的屏障是"一次 tool.exec 得到应答"（rig 注释）：应答之后才决策，
    // 所以 m-echo 必须在舱内真的跑成一次 ok——换入口不换来换去地把生命周期换松。
    const evModern = await rig.readRun("run-modern");
    const evLegacy = await rig.readRun("run-legacy");
    expect(okInvoked(evModern)).toEqual(["m-echo"]);
    expect(okInvoked(evLegacy)).toEqual(["sum"]);
    // 换入口不换隔离：两本账里都没有对方的工具名（按 "tool":"…" 精确匹配，
    // 免得被 payload 的 summary 字段误伤——"summary" 里就含 "sum"）
    expect(JSON.stringify(evLegacy)).not.toContain("m-echo");
    expect(JSON.stringify(evModern)).not.toContain('"tool":"sum"');
  }, 60_000);

  it("注意：新生态入口的插件不经通道注册（Phase 1 形状），其可见表由宿主既有路径给出", async () => {
    // 这条不是主张，而是把 F1 的边界写清楚：默认入口不会自己写内核分区
    const modern = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-modern2",
      runId: "run-modern2",
      pluginPath: coreFixtureFile("modern-peer.mjs"),
      entry: "default",
      plan: [{ visible: [], done: true }],
    });
    await modern.done;
    expect(modern.seen[0]).toEqual([]); // 空表 = 现状（承接层不负责新生态的声明通道）
  }, 60_000);
});

describe("反复增删不漂：版本单调、事件等量、seq 连续", () => {
  it("同一工具被运行期重复注册 12 次：每次 +1，账本变更条数与注册次数一致", async () => {
    const CHURNS = 12;
    const plan = Array.from({ length: CHURNS }, () => ({ call: { tool: "grow" } }));
    plan.push({ done: true });
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-churn",
      runId: "run-churn",
      pluginPath: fixtureFile("tierA-03-dynamic.cjs"),
      // 首轮 plan 里没有 visible，屏障不会自己成立：这里点名"activation 该交付的三个名字"
      boot: ["boot", "grow", "shrink"],
      plan,
    });
    expect((await probe.done).state).toBe("halted");

    const ev = await rig.readRun("run-churn");
    const changes = pick(ev, "TOOL_SCHEMA_CHANGED");
    // activation 三笔 + 每轮一笔 late
    expect(changes).toHaveLength(3 + CHURNS);
    const late = changes.filter((c) => c.tool === "late");
    expect(late.map((c) => c.newSchemaVersion)).toEqual(
      Array.from({ length: CHURNS }, (_, i) => i + 1),
    );
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
    // 版本按 scope 单调，不按 run 归零；且中间没有别的名字混进来
    expect(
      changes.filter(
        (c) => c.tool !== "boot" && c.tool !== "grow" && c.tool !== "shrink" && c.tool !== "late",
      ),
    ).toEqual([]);
  }, 90_000);
});
