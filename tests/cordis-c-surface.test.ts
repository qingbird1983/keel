/**
 * 集成测试（真实子进程）—— Phase 2 验收 **B3**：三条 C 档改法各一对 before/after。
 *
 * 主张逐条可断言（04 稿 §1，合同 §5 B3）：
 * - **#6 自调模型**：before = 消耗发生在上游标记文件里、账本关于它**零事实**，且旧面当场拒；
 *   after = 走网关一次，同 reqId 重放**不重复打上游、不重复计费**（数得出来）；
 * - **#8 共享可变状态**：before = 写共享袋当场拒且没有任何一半落下去；
 *   after = 谁产生谁持有 + 值经内核（工具结果 → 决策 → 下一轮入参）换舱，两域可见表互不可见；
 * - **#9 运行时回收**：before = 副作用做了却没有任何报关与补偿痕迹；
 *   after = 动手前报关 → 失败 → `RUN_FAILED` → 宿主补偿执行器**用承接层入口起新舱**执行
 *   `module.exports.compensations` 的动作 → `COMPENSATION_EXECUTED` 落账，重派不重复。
 *
 * 材料性质：合成样本（"我们设想的写法已验证"），不得表述为"真实存量插件已验证"（01 稿 §5）。
 * before 的"可见失败"与 after 的"凭据"都是**读账本**得到的，不是测试自己造数。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEvent, ModelUpstream } from "@keel/core";
import type { PermissionDecl } from "@keel/host";
import {
  createLegacyRig,
  fixtureFile,
  legacyManifest,
  policyFor,
  type RawTemplate,
  type RunProbe,
} from "./fixtures/cordis-rig";

const AGENT = "agent-b3";
/** #9 的补偿模板：动作 ref 与幂等口径都由这里给（插件提交不了，C-M1）。 */
const TEMPLATES: RawTemplate[] = [
  {
    kind: "fs.write.done",
    class: "reversible",
    action: { type: "plugin", ref: "undo-write" },
    idempotency: "keyed",
  },
];

let rig: ReturnType<typeof createLegacyRig>;
let sink = "";
let upstreamCalls = 0;
const open: { close(): Promise<void> }[] = [];

/** 可计数的上游桩（F8）：B3 的 #6 要数清"上游真的被打了几次"。 */
const countingUpstream: ModelUpstream = {
  invoke: async () => {
    upstreamCalls += 1;
    return { result: { text: "stub-answer" }, usage: { tokens: 5 }, cost: 3 };
  },
};

async function rigWith(caps: PermissionDecl[]): Promise<void> {
  rig = createLegacyRig({ upstream: countingUpstream });
  open.push(rig);
  await rig.setup(policyFor(legacyManifest(caps), AGENT));
}

beforeEach(async () => {
  upstreamCalls = 0;
  sink = await mkdtemp(path.join(tmpdir(), "keel-b3-"));
  await rigWith([{ cap: "tool.provide" }]);
});

afterEach(async () => {
  await Promise.allSettled(open.map((r) => r.close()));
  open.length = 0;
  await rm(sink, { recursive: true, force: true });
});

function count(eventsList: LedgerEvent[], type: string): number {
  return eventsList.filter((e) => e.type === type).length;
}

/** 某个工具最后一条 TOOL_RESULT。 */
function lastResult(eventsList: LedgerEvent[], tool: string): Record<string, unknown> {
  const hit = eventsList
    .filter((e) => e.type === "TOOL_RESULT")
    .reverse()
    .find((e) => (e.payload as { tool?: string }).tool === tool);
  return (hit?.payload ?? {}) as Record<string, unknown>;
}

describe("B3 #6：自带 key 调模型 → 走网关（真实进程）", () => {
  it("before：消耗发生在账本之外，且旧面 ctx.llm.chat 当场拒（不降级成本地调用）", async () => {
    const marker = path.join(sink, "selfkey-upstream-call.json").replace(/\\/g, "/");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-6b",
      runId: "run-6b",
      pluginPath: fixtureFile("tierC-06-self-key.cjs"),
      plan: [
        {
          visible: ["selfkey.ask"],
          call: {
            tool: "selfkey.ask",
            params: { sinkDir: sink.replace(/\\/g, "/"), model: "gpt-stub", prompt: "hi" },
          },
        },
        { done: true },
      ],
    });
    await probe.done;

    const evs = await rig.readRun("run-6b");
    // 1) 那次"自己打上游"真的发生了（舱外事实，靠标记文件证明）
    expect(existsSync(marker), "out-of-band upstream call did not happen").toBe(true);
    // 2) 内核关于它**零事实**：没有网关、没有预扣、没有实结
    expect(count(evs, "MODEL_INVOKED")).toBe(0);
    expect(count(evs, "MODEL_USAGE")).toBe(0);
    expect(count(evs, "BUDGET_RESERVED")).toBe(0);
    expect(count(evs, "BUDGET_SETTLED")).toBe(0);
    expect(upstreamCalls).toBe(0);
    // 3) 旧面是**可见失败**，不是静默降级
    const res = lastResult(evs, "selfkey.ask");
    expect(res.status).toBe("error");
    expect((res.error as { code: string }).code).toBe("ADAPTER/UNSUPPORTED");
    // 4) 半截结果没有落进账本（`written` 那条 return 走不到）
    expect(res.resultDigest).toBeUndefined();
  });

  it("after：ctx.model.invoke 同 reqId 打两次 → 上游只被打一次、账本只记一次、第二次是 replay", async () => {
    await rigWith([{ cap: "tool.provide" }, { cap: "model.adapter" }]);
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-6a",
      runId: "run-6a",
      pluginPath: fixtureFile("tierC-06-gateway.cjs"),
      plan: [
        {
          visible: ["gateway.ask"],
          call: {
            tool: "gateway.ask",
            params: { reqId: "req-b3-1", model: "gpt-stub", prompt: "hi", estimate: 100 },
          },
        },
        { done: true },
      ],
    });
    await probe.done;
    expect(probe.violations).toEqual([]);

    const evs = await rig.readRun("run-6a");
    const digest = lastResult(evs, "gateway.ask").resultDigest as Record<string, never>;
    expect(digest.first).toEqual({ cost: 3, usage: { tokens: 5 }, replay: false });
    expect(digest.retry).toEqual({ cost: 3, usage: { tokens: 5 }, replay: true });
    // 数得出来的三条主张：一次真实上游 / 一次预扣一次实结 / 用量只记一份
    expect(upstreamCalls).toBe(1);
    expect(count(evs, "MODEL_INVOKED")).toBe(1);
    expect(count(evs, "MODEL_USAGE")).toBe(1);
    expect(count(evs, "BUDGET_RESERVED")).toBe(1);
    expect(count(evs, "BUDGET_SETTLED")).toBe(1);
  });
});

describe("B3 #8：共享可变状态 → 谁产生谁持有 + 值经内核换舱（真实进程、两个作用域）", () => {
  it("before：写对方的状态当场拒，且没有任何一半落下去", async () => {
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-8b",
      runId: "run-8b",
      pluginPath: fixtureFile("tierC-08-share.cjs"),
      plan: [
        { visible: ["note.try-share"], call: { tool: "note.try-share", params: { token: "T-1" } } },
        { done: true },
      ],
    });
    await probe.done;

    const res = lastResult(await rig.readRun("run-8b"), "note.try-share");
    expect(res.status).toBe("error");
    expect((res.error as { code: string }).code).toBe("ADAPTER/UNSUPPORTED");
    expect(res.resultDigest).toBeUndefined(); // "写了但看不见"这种形态不存在
  });

  it("after：产生方的值经内核传到消费方，两域可见表互不可见，状态仍留在产生方舱内", async () => {
    const token = "TK-42";
    const producer: RunProbe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-8a-prod",
      runId: "run-8a-prod",
      pluginPath: fixtureFile("tierC-08-carry.cjs"),
      plan: [
        {
          visible: ["note.new", "note.peek"],
          absent: ["note.audit", "note.noise"],
          call: { tool: "note.new", params: { token } },
        },
        { call: { tool: "note.peek" } }, // 同舱第二轮：状态确实还在自己手里
        { done: true },
      ],
    });
    const prodStatus = await producer.done;
    // 域与域之间靠 **scope**（{agentId, sessionId}）分开，不靠换授权主体：
    // 换 agentId 就换了策略主体，那份策略里没有它的注册规则（这一行断言就是防这种静默起舱失败）。
    expect(prodStatus.state).toBe("halted");
    expect(producer.violations).toEqual([]);

    const prodEvents = await rig.readRun("run-8a-prod");
    expect(lastResult(prodEvents, "note.new").resultDigest).toEqual({ token });
    expect(lastResult(prodEvents, "note.peek").resultDigest).toEqual({
      owned: { token, seenTimes: 1 },
    });

    // 值经**内核**过去：测试从产生方那轮的 TOOL_RESULT 账本里读出来，再作为消费方的入参发进去
    const carried = (lastResult(prodEvents, "note.new").resultDigest as { token: string }).token;
    const consumer: RunProbe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-8a-cons",
      runId: "run-8a-cons",
      pluginPath: fixtureFile("tierC-08-peer.cjs"),
      plan: [
        {
          visible: ["note.audit", "note.noise"],
          absent: ["note.new", "note.peek"],
          call: { tool: "note.audit", params: { token: carried } },
        },
        { done: true },
      ],
    });
    const consStatus = await consumer.done;
    expect(consStatus.state).toBe("halted");
    expect(consumer.violations).toEqual([]);

    const digest = lastResult(await rig.readRun("run-8a-cons"), "note.audit")
      .resultDigest as Record<string, unknown>;
    expect(digest.got).toBe(token); // 换了舱，值没变
    expect(digest.visibleHere).toEqual(["note.audit", "note.noise"]); // 只看得见自己域里的名字
    // ctx.ledger.read 在真链路上读到了本 run 的既有事实（至少：装配基线 + 起 run + 本次派发）
    const seen = digest.ledgerTypes as string[];
    expect(seen).toContain("ASSEMBLY_RECORDED");
    expect(seen).toContain("RUN_STARTED");
    expect(seen).toContain("TOOL_INVOKE");
  });
});

describe("B3 #9：运行时回收 → 动手前报关 + 补偿真执行（真实进程，含回滚新舱）", () => {
  it("before：副作用做了，但既没有报关也没有补偿痕迹", async () => {
    const target = path.join(sink, "orphan-write.txt").replace(/\\/g, "/");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-9b",
      runId: "run-9b",
      pluginPath: fixtureFile("tierC-09-reclaim.cjs"),
      plan: [
        {
          visible: ["side.write"],
          call: { tool: "side.write", params: { sinkFile: target, text: "hello", tag: "b3" } },
        },
        { done: true },
      ],
    });
    await probe.done;

    const evs = await rig.readRun("run-9b");
    expect(existsSync(target), "the side effect itself must have happened").toBe(true);
    const res = lastResult(evs, "side.write");
    expect(res.status).toBe("error");
    expect((res.error as { code: string }).code).toBe("ADAPTER/UNSUPPORTED");
    // 没人知道这件事：既没有 EFFECT_DECLARED，也没有任何补偿痕迹
    expect(count(evs, "EFFECT_DECLARED")).toBe(0);
    expect(count(evs, "COMPENSATION_EXECUTED")).toBe(0);
    expect(existsSync(`${target}.undo`)).toBe(false);
  });

  it("after：报关 → 失败 → RUN_FAILED → 承接层入口的新舱执行补偿 → 重派不重复", async () => {
    const target = path.join(sink, "declared-write.txt").replace(/\\/g, "/");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-9a",
      runId: "run-9a",
      pluginPath: fixtureFile("tierC-09-declare.cjs"),
      templates: TEMPLATES,
      compensate: true,
      plan: [
        {
          visible: ["side.write"],
          call: {
            tool: "side.write",
            params: { sinkFile: target, text: "hello-world" },
          },
        },
        { abort: { code: "TEST/ABORT-B3", message: "slice-3 rollback drill" } },
      ],
    });
    const status = await probe.done;
    expect(probe.violations).toEqual([]);

    const evs = await rig.readRun("run-9a");
    // 1) 报关在先，且动作/幂等口径来自报关单（不是插件临场编的）
    const declared = evs.find((e) => e.type === "EFFECT_DECLARED");
    expect(declared?.payload).toMatchObject({
      kind: "fs.write.done",
      targetSummary: target,
      compensation: { actionRef: "undo-write", idempotency: "keyed" },
    });
    // 2) 动手之后失败 → 结算为"结果未知"（保守语义）
    expect(lastResult(evs, "side.write").status).toBe("error");
    expect(existsSync(`${target}.undo`), "compensation action did not run").toBe(true);
    const settled = evs.find((e) => e.type === "EFFECT_SETTLED");
    expect(settled?.payload).toMatchObject({ outcome: "unknown" });
    // 3) 终态是可见失败，补偿动作真在新舱里跑了（文件被撤 + 落账）
    expect(status).toMatchObject({ state: "failed", reasonCode: "TEST/ABORT-B3" });
    expect(existsSync(target), "the side effect was not undone").toBe(false);
    const executed = evs.find((e) => e.type === "COMPENSATION_EXECUTED");
    expect(executed?.payload).toMatchObject({ attempt: 1, resultDigest: { undone: true } });
    const undoLog = await readFile(`${target}.undo`, "utf-8");
    expect(undoLog.trim().split("\n")).toHaveLength(1);
    // 4) 重派幂等：闭环后再派一次，既不重复执行也不重复落账
    expect(await probe.compensate?.()).toBe(true);
    const after = await rig.readRun("run-9a");
    expect(count(after, "COMPENSATION_EXECUTED")).toBe(1);
    expect((await readFile(`${target}.undo`, "utf-8")).trim().split("\n")).toHaveLength(1);
    // 5) 快照面同理由承接层入口登记（旧插件的 `module.exports.snapshot` 能被宿主索取到）
    expect(await probe.cell.conn.request("cell.snapshot", {}, 3_000)).toMatchObject({
      state: { phase: "declared-writer" },
    });
  });
});

describe("B3 的反向保障：改法地面不是放行旧面", () => {
  it("未报关 model.adapter 的插件调 ctx.model.invoke → 内核拒（AUTH/DENIED），不是承接层兜底", async () => {
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-6d",
      runId: "run-6d",
      // 缺省 caps 只有 tool.provide —— 网关那一步必须由内核拒
      pluginPath: fixtureFile("tierC-06-gateway.cjs"),
      plan: [
        {
          visible: ["gateway.ask"],
          call: {
            tool: "gateway.ask",
            params: { reqId: "req-denied", model: "gpt-stub", prompt: "hi", estimate: 100 },
          },
        },
        { done: true },
      ],
    });
    await probe.done;

    const res = lastResult(await rig.readRun("run-6d"), "gateway.ask");
    expect(res.status).toBe("error");
    expect((res.error as { code: string }).code).toBe("AUTH/DENIED");
    expect(upstreamCalls).toBe(0);
  });
});
