/**
 * 集成测试（真实子进程）—— Phase 2 验收 **B2**：无报关单的旧插件经合成路径产出候选 → 五步校验 → 跑起来，
 * 且"多声明不放行"（03 稿 §7 第三行）。
 *
 * 为什么从 `apps/keel` 引 `observePlugin`：观察两遍是**宿主侧装配工具**的行为（要起内核、要换策略、
 * 要落候选文件），不是舱内承接面的一部分；B2 验收的正就是这个工具在真实进程上的结果，
 * 所以这里按产品入口验，而不是在测试里重抄一遍接线。
 *
 * 断言的三条硬线：
 * ① 第一趟**不放行任何东西**也能读到调用面——注册尝试都以 `AUTH_DENIED` 入账（观察 = 拒绝并记录，F4）；
 * ② 候选的 allow 恰好等于观察到的名字集（不多不少，排序确定）；用它装配并跑通 → B2 的"跑起来"；
 * ③ 声明之外的调用照样被当场拒（`tool.provide` 的资源维度，F5 决定了这是本片唯一能做成硬拦截的面），
 *    而**放宽到四个名字之后同一次调用才成功**——证明拒绝来自上界，不是来自某处硬编码的黑名单。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LedgerEvent } from "@keel/core";
import { observePlugin } from "../apps/keel/src/observe.js";
import {
  cordisCellEntry,
  createLegacyRig,
  fixtureFile,
  legacyManifest,
  policyFor,
} from "./fixtures/cordis-rig";

const AGENT = "agent-b2";
/** 承接层入口（子进程只跑 dist，构建由 vitest globalSetup 统一做一次）。 */
const cellEntry = cordisCellEntry;
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-b2-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function types(events: LedgerEvent[]): string[] {
  return events.map((e) => e.type);
}

function deniedActions(events: LedgerEvent[], action: string): string[] {
  return events
    .filter((e) => e.type === "AUTH_DENIED" && (e.payload as { action?: string }).action === action)
    .map((e) => String((e.payload as { resource?: string }).resource));
}

function results(events: LedgerEvent[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.type === "TOOL_RESULT")
    .map((e) => e.payload as Record<string, unknown>);
}

async function observe(plugin: string, tag: string) {
  return observePlugin({
    dataDir: path.join(dir, tag),
    pluginPath: fixtureFile(plugin),
    cellEntry,
    agentId: AGENT,
    sessionId: `sess-${tag}`,
    toolCallTimeoutMs: 5_000,
  });
}

describe("B2①：两遍观察 → 候选 → 五步校验 → 跑起来", () => {
  it("调用面全部经通道的插件：候选完整、无越权放行、真的被驱动执行", async () => {
    const r = await observe("tierB-01-no-manifest.cjs", "b2-01");

    // ① 第一趟什么都没放行：三个注册尝试全部以拒绝入账
    const pass1 = r.passes[0];
    expect(deniedActions(pass1.events, "tool.register").sort()).toEqual([
      "gated",
      "plain",
      "unlocker",
    ]);
    expect(types(pass1.events)).not.toContain("TOOL_INVOKE"); // 没放行就没有执行
    expect(pass1.status.state).toBe("failed"); // 被拒 → 舱崩（可见失败，不是悄悄不注册）
    expect(pass1.candidate.toolNames).toEqual(["gated", "plain", "unlocker"]);

    // ② 第二趟用的就是第一趟的候选：allow 恰好等于观察到的名字集
    const pass2 = r.passes[1];
    expect(JSON.parse(JSON.stringify(pass2.candidate.raw.permissions))).toEqual([
      { cap: "tool.provide", allow: ["gated", "plain", "unlocker"] },
    ]);
    expect(r.assembled).toBeDefined(); // 候选过了五步校验（无越界能力 → 不需要补偿模板）

    // ③ 覆盖驱动真的把三个工具在自己舱里跑成了
    expect(types(pass2.events).filter((t) => t === "TOOL_INVOKE")).toHaveLength(3);
    expect(results(pass2.events).every((p) => p.status === "ok")).toBe(true);
    expect(pass2.status.state).toBe("halted");
    expect(pass2.status.rounds).toBeGreaterThanOrEqual(4); // 三调用 + 收束
  }, 120_000);

  it("候选里的 allow 是上界：名字不在上界内 → 当场拒 + 两半不写；补进上界后同一次调用才成", async () => {
    // ① 两遍观察：第一趟拿到三个名字；第二趟 unlocker 被真正调用，它要注册的第四个名字被拒
    const r = await observe("tierB-02-conditional.cjs", "b2-02");
    expect(r.passes[0].candidate.toolNames).toEqual(["gated", "plain", "unlocker"]);
    const bonusDenials = deniedActions(r.passes[1].events, "tool.register");
    expect(bonusDenials).toEqual(["bonus"]); // 少声明 → 拒（观察追加的来源）
    expect(r.candidate.toolNames).toEqual(["bonus", "gated", "plain", "unlocker"]);
    // 被拒的那次调用是可见失败，不是静默：账本里它带错误码
    const unlockerResult = results(r.passes[1].events).find((p) => p.tool === "unlocker");
    expect(unlockerResult?.status).toBe("error");
    expect((unlockerResult?.error as { code?: string }).code).toBe("AUTH/DENIED");

    // ② 人工把第四个别进候选里（= 审核后转正）：同一次调用这才成立
    const rig = createLegacyRig();
    const caps = [{ cap: "tool.provide", allow: ["bonus", "gated", "plain", "unlocker"] }];
    await rig.setup(policyFor(legacyManifest(caps), AGENT));
    try {
      const probe = rig.runLegacy({
        agentId: AGENT,
        sessionId: "sess-b2-02-audited",
        runId: "run-b2-02-audited",
        pluginPath: fixtureFile("tierB-02-conditional.cjs"),
        caps,
        boot: ["gated", "plain", "unlocker"],
        plan: [
          {
            visible: ["gated", "plain", "unlocker"],
            absent: ["bonus"],
            call: { tool: "unlocker" },
          },
          { visible: ["bonus"], call: { tool: "bonus" } },
          { done: true },
        ],
      });
      const st = await probe.done;
      expect(st.state).toBe("halted");
      expect(probe.violations).toEqual([]);
      const events = await rig.readRun("run-b2-02-audited");
      expect(deniedActions(events, "tool.register")).toEqual([]); // 上界内 → 全程没有拒绝
      expect(results(events).find((p) => p.tool === "unlocker")?.status).toBe("ok");
    } finally {
      await rig.close();
    }
  }, 180_000);
});

describe("B2②：合成不完备性必须写在明面上", () => {
  it("原生文件调用不进候选，进缺项；旧框架网络面是一笔可见失败", async () => {
    const r = await observe("tierB-03-native-io.cjs", "b2-03");
    const caps = JSON.parse(JSON.stringify(r.candidate.raw.permissions)) as { cap: string }[];
    expect(caps.map((c) => c.cap)).toEqual(["tool.provide"]); // 没有 net.fetch/fs.read——因为观察不到
    const codes = r.candidate.gaps.map((g) => g.code);
    expect(codes).toContain("UNOBSERVABLE_NATIVE_IO");
    expect(codes).toContain("HANDLER_NOT_COVERED"); // try-cordis-net 那一次没跑成，覆盖度如实记录

    // 原生文件调用照样跑得通（它从来不需要内核批准），但账本里关于它一条事实都没有：
    const pass2 = r.passes[1];
    const native = results(pass2.events).find((p) => p.tool === "native-fs");
    expect(native?.status).toBe("ok");
    expect(Number((native?.resultDigest as { entries?: number })?.entries)).toBeGreaterThan(0);
    expect(JSON.stringify(pass2.events)).not.toContain("fs.read"); // 没经通道 = 没证据
    // 旧框架网络面：拒绝是可见事件，不返回空值装作成功
    const net = results(pass2.events).find((p) => p.tool === "try-cordis-net");
    expect(net?.status).toBe("error");
    expect((net?.error as { code?: string }).code).toBe("ADAPTER/UNSUPPORTED");
  }, 120_000);
});
