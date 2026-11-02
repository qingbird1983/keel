/**
 * 集成测试（真实子进程）—— Phase 2 验收 B1（一票否决）的合成组这一半。
 *
 * 主张逐条可证伪（合同 §5 B1）：
 * ① A 档插件**一行不改**跑通——"一行不改"由 tests/cordis-symbol-scan.test.ts 机械核对，
 *    本文件负责"跑通"：注册 → 可见 → 被决策选中 → 在自己舱里执行 → 账本完整；
 * ② 会话间工具表互不可见——同名条目按 scope 各自记版本，他域名字零出现；
 * ③ 崩溃只伤本舱——逃逸异常落 RUN_FAILED{CELL/CRASH}，邻居会话零扰动。
 * 外加四枚最坏写法探针（合同 §2 明文要求）与一枚反例（能力未报关）。
 *
 * 材料性质：合成样本，证明"我们设想的写法已验证"，**不**证明"真实存量插件可迁移"（合同风险 1）。
 * 可见表由插件自己的运行期注册填充（不是测试造数）——driver 只从内核送进来的表里选工具，
 * 预期缺席即记违规，所以"可见性一半没接通"在本文件里无处藏身（02 稿 §2 F1 的正面解法）。
 */

import { execSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEvent } from "@keel/core";
import {
  createLegacyRig,
  fixtureFile,
  legacyManifest,
  policyFor,
  repoRoot,
} from "./fixtures/cordis-rig";

const AGENT = "agent-b1";
let rig: ReturnType<typeof createLegacyRig>;

/** 子进程只跑 dist：先把内核与承接层的产物准备好（P-002 规则 4）。 */
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

function types(events: LedgerEvent[]): string[] {
  return events.map((e) => e.type);
}

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

describe("B1①：注册→可见→可执行全链打通（真实进程）", () => {
  it("旧形状插件的三个工具被内核发给决策、被选中、在自己舱里执行，账本完整", async () => {
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-01",
      runId: "run-01",
      pluginPath: fixtureFile("tierA-01-toolset.cjs"),
      plan: [
        { visible: ["echo", "sum", "tag"], call: { tool: "echo", params: { x: 7 } } },
        { call: { tool: "sum", params: { a: 2, b: 40 } } },
        { call: { tool: "tag" } },
        { done: true },
      ],
    });
    const status = await probe.done;

    expect(probe.violations).toEqual([]);
    expect(status.state).toBe("halted");
    expect(probe.seen[0]).toEqual(["echo@1", "sum@1", "tag@1"]); // 版本来自内核指派

    const events = await rig.readRun("run-01");
    expect(events[0].type).toBe("ASSEMBLY_RECORDED"); // 装配基线先落账
    expect((events[0].payload as { permissions: { cap: string }[] }).permissions).toEqual([
      { cap: "tool.provide" },
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1)); // seq 连续无缺
    expect(types(events).filter((t) => t === "TOOL_INVOKE")).toHaveLength(3);
    expect(digestOf(events, "echo")).toEqual({ echoed: { x: 7 } }); // handler 在舱内跑
    expect(digestOf(events, "sum")).toEqual({ sum: 42 });
    expect(digestOf(events, "tag")).toEqual({ tag: "tierA-01" });
    // 三笔注册变更都进账且只归本域
    const changes = events
      .filter((e) => e.type === "TOOL_SCHEMA_CHANGED")
      .map((e) => e.payload as { tool: string; affectedScope: { sessionId: string } });
    expect(changes.map((c) => c.tool).sort()).toEqual(["echo", "sum", "tag"]);
    expect(changes.every((c) => c.affectedScope.sessionId === "sess-01")).toBe(true);
  }, 60_000);
});

describe("B1②：会话间工具表互不可见（同名各版本，零他域条目）", () => {
  it("两会话同时注册同名 flip：一边覆盖到 v2、一边停在 v1，彼此看不见也影响不到", async () => {
    const a = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-a",
      runId: "run-a",
      pluginPath: fixtureFile("tierA-02-overwrite.cjs"),
      plan: [
        { visible: ["flip", "reported"], call: { tool: "reported" } },
        { call: { tool: "flip" } },
        { done: true },
      ],
    });
    const b = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-b",
      runId: "run-b",
      pluginPath: fixtureFile("tierA-02-peer.cjs"),
      plan: [{ visible: ["flip"], absent: ["reported"], call: { tool: "flip" } }, { done: true }],
    });
    const [sa, sb] = await Promise.all([a.done, b.done]);

    expect([a.violations, b.violations]).toEqual([[], []]);
    expect([sa.state, sb.state]).toEqual(["halted", "halted"]);
    expect(a.seen[0]).toEqual(["flip@2", "reported@1"]); // 本会话覆盖过一次
    expect(b.seen[0]).toEqual(["flip@1"]); // 邻居的覆盖不动本域版本
    expect(digestOf(await rig.readRun("run-a"), "reported")).toEqual({
      name: "flip",
      schemaVersion: 2,
    });
    expect(digestOf(await rig.readRun("run-a"), "flip")).toEqual({ v: 2 });
    expect(digestOf(await rig.readRun("run-b"), "flip")).toEqual({ v: 1, from: "peer" });

    // 他域条目在对方的任何事件里都不出现（run-b 的账本里没有 reported）
    const evB = await rig.readRun("run-b");
    expect(JSON.stringify(evB)).not.toContain("reported");
  }, 60_000);

  it("末轮之后再注册一笔：本 run 不入账（无作用对象），但跨 run 的版本仍按 scope 连续", async () => {
    // 同一 scope 的第二个 run 复用分区：flip 已经是 v2 → 再覆盖即 v3
    const first = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-c",
      runId: "run-c1",
      pluginPath: fixtureFile("tierA-02-overwrite.cjs"),
      plan: [{ visible: ["flip", "reported"], call: { tool: "flip" } }, { done: true }],
    });
    await first.done;
    const second = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-c",
      runId: "run-c2",
      pluginPath: fixtureFile("tierA-02-peer.cjs"), // 同名再注册 → 版本继续 +1
      // 屏障按版本等：分区里本来就写着 flip@2，只等名字就会把"本舱注册到 v3"漏掉
      boot: ["flip@3"],
      plan: [{ visible: ["flip"], call: { tool: "flip" } }, { done: true }],
    });
    await second.done;
    expect(second.barrierGaveUp).toBe(false);
    // 分区是 scope 级的，不按 run 归零：上一 run 注册的 reported 仍在本域可见表里，
    // 本 run 的 flip 继续从 v2 走到 v3（不是"新 run 重新从 1 开始"）
    expect(second.seen[0]).toEqual(["flip@3", "reported@1"]);
  }, 60_000);
});

describe("B1③：运行期动态增删 + 崩溃只伤本舱", () => {
  it("handler 里注册的新工具下一轮才可见；撤掉的工具再点名 = 明确失败留痕", async () => {
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-03",
      runId: "run-03",
      pluginPath: fixtureFile("tierA-03-dynamic.cjs"),
      plan: [
        { visible: ["boot", "grow", "shrink"], absent: ["late"], call: { tool: "grow" } },
        { visible: ["late"], call: { tool: "shrink" } }, // late 在第二轮进入决策输入
        { absent: ["boot"], call: { tool: "boot" } }, // 已下线：点名它应落成一次可见失败
        { done: true },
      ],
    });
    const status = await probe.done;
    expect(probe.violations).toEqual([]);
    expect(status.state).toBe("halted");

    const events = await rig.readRun("run-03");
    const changes = events
      .filter((e) => e.type === "TOOL_SCHEMA_CHANGED")
      .map((e) => e.payload as { tool: string; newSchemaVersion: number });
    // activation 三笔 + 运行期新增一笔 + 下线一笔（newSchemaVersion=0）
    expect(changes.map((c) => c.tool)).toEqual(["boot", "grow", "shrink", "late", "boot"]);
    expect(changes[4].newSchemaVersion).toBe(0);

    // 生效时刻 = 下一轮：late 的变更事件排在"注册它的那一轮动作"之后、下一轮决策之前。
    // （锚在 grow 这次调用上而不是"第 1/2 个 DECISION"上：激活屏障自己也会空转若干轮。）
    const seqLate = events.find((e) => (e.payload as { tool?: string }).tool === "late")?.seq ?? 0;
    const growInvoke =
      events.find(
        (e) => e.type === "TOOL_INVOKE" && (e.payload as { tool?: string }).tool === "grow",
      )?.seq ?? 0;
    const shrinkInvoke =
      events.find(
        (e) => e.type === "TOOL_INVOKE" && (e.payload as { tool?: string }).tool === "shrink",
      )?.seq ?? 0;
    const decideBeforeShrink =
      events.filter((e) => e.type === "DECISION" && e.seq < shrinkInvoke).at(-1)?.seq ?? 0;
    expect(growInvoke).toBeGreaterThan(0);
    expect(seqLate).toBeGreaterThan(growInvoke);
    expect(seqLate).toBeLessThan(decideBeforeShrink);

    // 点名已下线的工具：不静默——账本里是一次带错误码的失败
    const bootResult = results(events).find((p) => p.tool === "boot" && p.status !== "ok");
    expect(bootResult).toBeDefined();
    expect((bootResult?.error as { code?: string })?.code).toBe("CELL/TOOL-UNKNOWN");
  }, 60_000);

  it("插件逃逸异常只让自己的 run 落 RUN_FAILED{CELL/CRASH}，邻居会话零扰动", async () => {
    const risky = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-04",
      runId: "run-04",
      pluginPath: fixtureFile("tierA-04-crash.cjs"),
      plan: [
        { visible: ["safe", "boom"], call: { tool: "safe" } },
        { call: { tool: "boom" } }, // handler 脱栈抛出 → 本舱非零退出
        { awaitCellExit: true, done: true }, // 等退出信号落地再收束：崩溃必须发生在 run 存活期间
      ],
    });
    const neighbor = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-05",
      runId: "run-05",
      pluginPath: fixtureFile("tierA-01-toolset.cjs"),
      plan: [
        { visible: ["echo", "sum", "tag"], call: { tool: "echo", params: { n: 1 } } },
        { call: { tool: "sum", params: { a: 1, b: 1 } } },
        { done: true },
      ],
    });
    const [rs, rn] = await Promise.all([risky.done, neighbor.done]);

    expect(rs.state).toBe("failed");
    expect(rs.reasonCode).toBe("CELL/CRASH");
    expect(rn.state).toBe("halted");
    expect(neighbor.violations).toEqual([]);
    expect(risky.seen.length).toBeGreaterThanOrEqual(1); // 崩溃前至少看清过自己的表
    expect(risky.violations).toEqual([]);

    const crashEvents = await rig.readRun("run-04");
    const failed = crashEvents.find((e) => e.type === "RUN_FAILED");
    expect((failed?.payload as { reasonCode?: string }).reasonCode).toBe("CELL/CRASH");
    // 崩之前的调用仍算数：safe 那次成功执行过（崩溃不追溯改写已落账的事实）
    expect(results(crashEvents).some((p) => p.tool === "safe" && p.status === "ok")).toBe(true);
    // 邻居账本里没有对方舱的东西（连工具名都不出现）
    expect(JSON.stringify(await rig.readRun("run-05"))).not.toContain("boom");
  }, 60_000);

  it("常驻定时器与忙等/挂起只占本舱：邻居耗时不被拖高，超时必须落成一条可见 timeout", async () => {
    const busy = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-06",
      runId: "run-06",
      pluginPath: fixtureFile("tierA-05-timer.cjs"),
      toolCallTimeoutMs: 400, // hang 那次会越过它：C-D3 的硬强制在舱内先落 timeout
      plan: [
        { visible: ["busy", "hang", "quick"], call: { tool: "busy" } },
        { call: { tool: "hang" } },
        { call: { tool: "quick" } },
        { done: true },
      ],
    });
    const light = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-07",
      runId: "run-07",
      pluginPath: fixtureFile("tierA-01-toolset.cjs"),
      plan: [
        { visible: ["echo", "sum", "tag"], call: { tool: "echo", params: { p: "a" } } },
        { call: { tool: "tag" } },
        { done: true },
      ],
    });
    const [sb, sl] = await Promise.all([busy.done, light.done]);
    expect([sb.state, sl.state]).toEqual(["halted", "halted"]);
    expect([busy.violations, light.violations]).toEqual([[], []]);

    const busyResults = results(await rig.readRun("run-06"));
    const lightResults = results(await rig.readRun("run-07"));
    const spin = busyResults.find((p) => p.tool === "busy");
    expect(Number(spin?.durationMs)).toBeGreaterThanOrEqual(240);
    // 邻居的工具轮次耗时远低于本舱那次忙等（结构隔离，不是"这次没发生"）
    expect(Math.max(...lightResults.map((p) => Number(p.durationMs)))).toBeLessThan(
      Number(spin?.durationMs),
    );
    // #13 的另一半：越界的 handler 不是"没结果"，而是一条带码的 timeout（禁止静默降级）
    const hang = busyResults.find((p) => p.tool === "hang");
    expect(hang?.status).toBe("timeout");
    expect((hang?.error as { code?: string })?.code).toBe("TRANSPORT/TIMEOUT");
    // 定时器在本舱持续跑（quick 让出了一次事件循环，所以不靠运气）
    expect(
      Number((digestOf(await rig.readRun("run-06"), "quick") as { ticks?: number }).ticks),
    ).toBeGreaterThan(0);
  }, 60_000);
});

describe("B1 探针：四种最坏写法都拿得出「污染通道不存在」的证据", () => {
  it("动态 require / 原型链补丁 / 进程级全局 / 加载顺序依赖，对照舱一律为 false", async () => {
    const r = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-p1",
      runId: "run-p1",
      pluginPath: fixtureFile("probe-require.cjs"),
      plan: [
        {
          visible: ["extra-sum", "lazy", "peek-cache"],
          call: { tool: "extra-sum", params: { n: 21 } },
        },
        { call: { tool: "lazy" } },
        { call: { tool: "peek-cache" } },
        { done: true },
      ],
    });
    const p = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-p2",
      runId: "run-p2",
      pluginPath: fixtureFile("probe-proto.cjs"),
      plan: [
        { visible: ["use-patch", "patch-here"], call: { tool: "use-patch" } },
        { call: { tool: "patch-here" } },
        { done: true },
      ],
    });
    const o = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-p3",
      runId: "run-p3",
      pluginPath: fixtureFile("probe-order.cjs"),
      plan: [
        { visible: ["alpha", "zeta", "expect-peer"], call: { tool: "expect-peer" } },
        { call: { tool: "beta-peer" } }, // 指望别的插件先注册：点名即失败
        { done: true },
      ],
    });
    const peer = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-p4",
      runId: "run-p4",
      pluginPath: fixtureFile("probe-peer.cjs"),
      plan: [{ visible: ["peer-quiet"], call: { tool: "peer-quiet" } }, { done: true }],
    });
    const all = await Promise.all([r.done, p.done, o.done, peer.done]);
    expect(all.every((s) => s.state === "halted")).toBe(true);
    expect([r.violations, p.violations, o.violations, peer.violations]).toEqual([[], [], [], []]);

    // 探针 1：动态 require 的工具确实注册成功、确实能跑（加载是舱内私事）
    expect(digestOf(await rig.readRun("run-p1"), "extra-sum")).toEqual({
      tool: "extra-sum",
      doubled: 42,
    });
    expect(digestOf(await rig.readRun("run-p1"), "lazy")).toEqual({
      counted: { label: "lazy", hits: 1 },
    });
    expect(digestOf(await rig.readRun("run-p1"), "peek-cache")).toMatchObject({ cached: true });

    // 探针 2：补丁在自己舱里生效（不是"没打上"，而是"打不上别人"）
    expect(digestOf(await rig.readRun("run-p2"), "use-patch")).toEqual({ last: 3 });
    expect(digestOf(await rig.readRun("run-p2"), "patch-here")).toEqual({ patched: true });

    // 探针 4：可见表内容只含自己注册的名字，且顺序无关（注册反序 → 视图稳定排序）
    expect(o.seen[0]).toEqual(["alpha@1", "expect-peer@1", "zeta@1"]);
    expect(digestOf(await rig.readRun("run-p3"), "expect-peer")).toEqual({
      visible: ["alpha", "expect-peer", "zeta"],
      hasBetaPeer: false,
    });
    const foreign = results(await rig.readRun("run-p3")).find((x) => x.tool === "beta-peer");
    expect((foreign?.error as { code?: string })?.code).toBe("CELL/TOOL-UNKNOWN");

    // 对照舱：三种外溢全为 false
    expect(digestOf(await rig.readRun("run-p4"), "peer-quiet")).toEqual({
      protoLeak: false,
      ctxLeak: false,
      requiredLeak: false,
    });
    // 宿主进程同样干净：补丁与全局都进不来（这是"结构上不存在"而非"这次没发生"的直接证据）
    expect((Array.prototype as unknown as { last?: unknown }).last).toBeUndefined();
    expect((globalThis as Record<string, unknown>).__CORDIS_CTX__).toBeUndefined();
  }, 90_000);

  it("探针 3：跨插件共享一律拒绝，且拒绝是可见事件（不返回 undefined 装作读到空值）", async () => {
    const g = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-g1",
      runId: "run-g1",
      pluginPath: fixtureFile("probe-global.cjs"),
      plan: [
        { visible: ["ctx-here", "try-share"], call: { tool: "ctx-here" } },
        { call: { tool: "try-share" } },
        { done: true },
      ],
    });
    const peer = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-g2",
      runId: "run-g2",
      pluginPath: fixtureFile("probe-peer.cjs"),
      plan: [{ visible: ["peer-quiet"], call: { tool: "peer-quiet" } }, { done: true }],
    });
    await Promise.all([g.done, peer.done]);

    expect(digestOf(await rig.readRun("run-g1"), "ctx-here")).toEqual({ ownGlobal: true });
    const share = results(await rig.readRun("run-g1")).find((p) => p.tool === "try-share");
    expect(share?.status).toBe("error"); // 落成一次可见失败，而不是 status:"ok" + 空值
    expect((share?.error as { code?: string })?.code).toBe("ADAPTER/UNSUPPORTED");
    expect(digestOf(await rig.readRun("run-g2"), "peer-quiet")).toMatchObject({ ctxLeak: false });
  }, 60_000);
});

describe("反例：报关单没报这项能力", () => {
  it("未声明 tool.provide 的插件：注册被当场拒绝且留痕，工具永不可见，邻居不受影响", async () => {
    const strict = createLegacyRig();
    // 策略按 §5.3 的 allow 收窄：只给"报关且把名字列进 allow"的那一家注册权。
    // 于是这一条同时证两件事——未报关的那家被挡下，而邻居的注册权来自它**自己**的报关单。
    const granted = legacyManifest([{ cap: "tool.provide", allow: ["echo", "sum", "tag"] }]);
    await strict.setup(policyFor(granted, AGENT));
    try {
      const denied = strict.runLegacy({
        agentId: AGENT,
        sessionId: "sess-n1",
        runId: "run-n1",
        pluginPath: fixtureFile("neg-undeclared.cjs"),
        caps: [],
        // 屏障按"这个名字会不会出现"等：等不到 → 舱退出 → 放弃。这条本身就是"永不可见"的证据。
        boot: ["should-not-appear"],
        plan: [{ done: true }],
      });
      const quiet = strict.runLegacy({
        agentId: AGENT,
        sessionId: "sess-n2",
        runId: "run-n2",
        pluginPath: fixtureFile("tierA-01-toolset.cjs"),
        caps: [{ cap: "tool.provide", allow: ["echo", "sum", "tag"] }],
        plan: [
          { visible: ["echo", "sum", "tag"], call: { tool: "echo", params: { keep: true } } },
          { done: true },
        ],
      });
      const [sd, sq] = await Promise.all([denied.done, quiet.done]);

      expect(sd.state).toBe("failed"); // activation 抛错 → 本舱非零退出
      // "永不可见"的直接证据 = 内核分区里一个条目都没有（不是"这轮没看到"）
      expect(
        strict.ctx
          .discover({ agentId: AGENT, sessionId: "sess-n1", runId: "run-n1" })
          .map((t) => t.name),
      ).toEqual([]);
      const ev = await strict.readRun("run-n1");
      const deniedEvent = ev.find((e) => e.type === "AUTH_DENIED");
      expect(deniedEvent?.payload).toMatchObject({
        action: "tool.register",
        resource: "should-not-appear",
      });
      expect(types(ev)).not.toContain("TOOL_INVOKE"); // 没有任何一半悄悄生效
      expect(JSON.stringify(ev)).not.toContain("also-absent");

      expect(sq.state).toBe("halted"); // 邻居照常
      expect(quiet.violations).toEqual([]);
    } finally {
      await strict.close();
    }
  }, 60_000);
});
