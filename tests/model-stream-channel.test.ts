/**
 * B7④（07 稿 §3.4 + ADR-0013）真进程验收：舱内 `model.stream` 跨通道之后的三件事。
 *
 * 时序假设（先写下再断言，P-006）：
 * - 上游是**测试注入**的（rig 的 `upstream` 面，切片③ F8），所以片数与"中途抛"都是确定量；
 *   唯一的实时约束是"内核默认页上限 16"——它出现在 `pages` 的第一项里，是断言不是巧合。
 * - 舱是真实子进程（默认入口装载 `stream-plugin.mjs`），分片要过 stdio 帧：
 *   单测能证记账不变式，证不了"错误与 id 穿得过通道"。
 * - 不级联（I2）靠两个 run 同时活着来观察：邻居流式失败，这边的账一条模型事件都不多。
 * - 断流的**计时路径**（首字节等待、会话总长）由单测的注入位覆盖；这里只走取消与上游抛两条
 *   即时终局——把 30 秒真实等待放进集成测试是错的（standards/05 §3）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEvent, ModelUpstream } from "@keel/core";
import { createLegacyRig, coreFixtureFile, legacyManifest, policyFor } from "./fixtures/cordis-rig";

const AGENT = "agent-stream";
/** `model.adapter` 编译出 model.invoke + model.stream 两条规则（ADR-0013 决策 6：不新开 cap）。 */
const CAPS = [{ cap: "tool.provide" }, { cap: "model.adapter" }];
/** 内核默认页上限（`STREAM_DEFAULT_LIMIT`）：首页片数由它决定，不是由上游决定。 */
const FIRST_PAGE = 16;

const upstream: ModelUpstream = {
  invoke: async () => ({ result: { text: "one-shot" }, usage: { tokens: 3 }, cost: 3 }),
  async *stream(req: { model: string; params: unknown }) {
    const p = (req.params ?? {}) as { chunks?: number; boomAfter?: number };
    if (typeof p.boomAfter === "number") {
      // 先正常出 boomAfter 片，然后**抛**：半截答案不能以"完成"的形状回到舱内
      for (let i = 1; i <= p.boomAfter; i++) {
        yield { chunk: { seq: i, text: `c${String(i)}` }, cost: 1, usage: { parts: i } };
      }
      throw new Error("upstream died mid-stream");
    }
    const n = p.chunks ?? 20;
    for (let i = 1; i <= n; i++) {
      yield {
        chunk: { seq: i, text: `c${String(i)}` },
        cost: 1,
        usage: { parts: i, tokens: i * 2 },
      };
    }
  },
};

let rig: ReturnType<typeof createLegacyRig>;

beforeEach(async () => {
  rig = createLegacyRig({ upstream });
  await rig.setup(policyFor(legacyManifest(CAPS), AGENT));
});
afterEach(async () => {
  await rig.close();
});

function pick(events: LedgerEvent[], type: string): Record<string, unknown>[] {
  return events.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
}

/** 某工具在账本上的成功结果（`TOOL_RESULT.resultDigest`）——读盘上的证据，不读内存里的桩。 */
function resultOf(events: LedgerEvent[], tool: string): Record<string, unknown> {
  const rows = pick(events, "TOOL_RESULT").filter((p) => p.tool === tool);
  expect(rows.length, `${tool} 应恰好执行一次`).toBe(1);
  expect(rows[0]!.status).toBe("ok");
  return rows[0]!.resultDigest as Record<string, unknown>;
}

function streamRun(runId: string, tool: string, params: Record<string, unknown>) {
  return rig.runLegacy({
    agentId: AGENT,
    sessionId: `sess-${runId}`,
    runId,
    pluginPath: coreFixtureFile("stream-plugin.mjs"),
    entry: "default",
    caps: CAPS,
    plan: [{ call: { tool, params } }, { done: true }],
  });
}

describe("B7④：model.stream 跨通道的分片顺序、断流闭环与不级联（真子进程）", () => {
  it("逐页取片：顺序 = 上游产出顺序，一次调用 = 一条 MODEL_INVOKED + 一条 MODEL_USAGE，分片不写事件", async () => {
    const probe = streamRun("run-order", "stream-all", {
      reqId: "req-order",
      chunks: 20,
      pageSize: 4,
    });
    expect((await probe.done).state).toBe("halted");
    expect(probe.violations).toEqual([]);

    const evs = await rig.readRun("run-order");
    const r = resultOf(evs, "stream-all");
    expect(r.seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // 首页 16（内核页上限）+ 4 + 终页 0：三次往返取完 20 片
    expect(r.pages).toEqual([FIRST_PAGE, 4, 0]);
    expect(r.produced).toBe(20);
    expect(r.cost).toBe(20); // 权威计量 = 上游逐片报的 cost 之和
    expect(r.usage).toMatchObject({ parts: 20 });
    expect(r.truncated).toBeNull(); // 正常结束不写 truncated

    // 四条记账不变式（ADR-0003 在流式路径上的落点）
    expect(pick(evs, "BUDGET_RESERVED")).toHaveLength(1);
    expect(pick(evs, "MODEL_INVOKED")).toHaveLength(1);
    expect(pick(evs, "BUDGET_SETTLED")).toHaveLength(1);
    expect(pick(evs, "MODEL_USAGE")).toHaveLength(1);
    const invoked = pick(evs, "MODEL_INVOKED")[0]!;
    expect(invoked.streamId).toBe(r.streamId); // 舱内拿到的 id 就是账上那一条的 id
    expect(pick(evs, "MODEL_USAGE")[0]).toMatchObject({ reqId: "req-order", cost: 20 });
    expect("truncated" in pick(evs, "MODEL_USAGE")[0]!).toBe(false);
    expect(pick(evs, "BUDGET_SETTLED")[0]).toMatchObject({ actual: 20, refund: 30 });
    // 20 片只留下"结算"这一条：账本体积不是流长度的函数（ADR-0008 决策 3 反对的那个平方）
    const from = evs.findIndex((e) => e.type === "MODEL_INVOKED");
    const to = evs.findIndex((e) => e.type === "MODEL_USAGE");
    expect(evs.slice(from + 1, to).map((e) => e.type)).toEqual(["BUDGET_SETTLED"]);
    // 信封按类型升版：MODEL_INVOKED = 2（streamId），MODEL_USAGE = 3（桶/档/计价来源）
    expect(evs[from].schemaVersion).toBe(2);
    expect(evs[to].schemaVersion).toBe(3);
  }, 120_000);

  it("舱内主动取消：已交付的一满页结算，之后的 next 只是终局重放", async () => {
    const probe = streamRun("run-cancel", "stream-cancel", { reqId: "req-cancel", chunks: 20 });
    expect((await probe.done).state).toBe("halted");

    const evs = await rig.readRun("run-cancel");
    const r = resultOf(evs, "stream-cancel");
    expect(r.delivered).toBe(FIRST_PAGE);
    expect(r.cancelled).toMatchObject({ settled: true, cost: FIRST_PAGE, truncated: true });
    expect(r.afterReplay).toBe(true);
    expect(r.afterChunks).toBe(0); // 重放不重产内容（ADR-0013 决策 5：流式不重放）
    expect(r.afterDone).toBe(true);

    expect(pick(evs, "MODEL_INVOKED")).toHaveLength(1);
    expect(pick(evs, "MODEL_USAGE")).toHaveLength(1);
    expect(pick(evs, "MODEL_USAGE")[0]).toMatchObject({ cost: FIRST_PAGE, truncated: true });
    // 取消不静默全额退还：已经给出去 16 片就是花掉了 16，剩下的 34 退还
    expect(pick(evs, "BUDGET_SETTLED")[0]).toMatchObject({ actual: FIRST_PAGE, refund: 34 });
  }, 120_000);

  it("上游中途抛：账本走断流口径（一条用量 + 一次 settle），舱内看到的是错误；邻居 Cell 不受影响", async () => {
    const boom = streamRun("run-boom", "stream-boom", { reqId: "req-boom", boomAfter: 2 });
    const peer = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-peer",
      runId: "run-peer",
      pluginPath: coreFixtureFile("stream-plugin.mjs"),
      entry: "default",
      caps: CAPS,
      plan: [{ call: { tool: "ping" } }, { call: { tool: "ping" } }, { done: true }],
    });
    const [sb, sp] = await Promise.all([boom.done, peer.done]);
    // 发起方本轮也没被打挂：handler 接住了错误，run 照常收束（失败的是这一次调用，不是这个舱）
    expect([sb.state, sp.state]).toEqual(["halted", "halted"]);

    const evsBoom = await rig.readRun("run-boom");
    const r = resultOf(evsBoom, "stream-boom");
    expect(r.threw).toBe(true);
    expect(r.code).toBe("GATEWAY/UPSTREAM-ERROR");
    expect(r.reason).toBe("STREAM_UPSTREAM_THROW");
    expect(r.produced).toBe(2); // 穿得过通道的不只是"失败了"，还有"失败前给了几片"
    expect(r.cost).toBe(2);

    // 闭环：一条 MODEL_INVOKED + 一条 truncated 的 MODEL_USAGE + 一次 settle（无 settle 不算完成）
    expect(pick(evsBoom, "BUDGET_RESERVED")).toHaveLength(1);
    expect(pick(evsBoom, "MODEL_INVOKED")).toHaveLength(1);
    expect(pick(evsBoom, "MODEL_USAGE")).toHaveLength(1);
    expect(pick(evsBoom, "MODEL_USAGE")[0]).toMatchObject({ cost: 2, truncated: true });
    expect(pick(evsBoom, "BUDGET_SETTLED")[0]).toMatchObject({ actual: 2, refund: 48 });

    // 不级联（I2）：邻居的账里一条模型事件都没有，事件归属也没混
    const evsPeer = await rig.readRun("run-peer");
    expect(evsPeer.filter((e) => e.type.startsWith("MODEL"))).toEqual([]);
    expect(evsPeer.every((e) => e.runId === "run-peer")).toBe(true);
    expect(JSON.stringify(evsPeer)).not.toContain(String(r.streamId ?? "stm-"));
    expect(pick(evsPeer, "TOOL_RESULT").every((p) => p.status === "ok")).toBe(true);
    expect(pick(evsPeer, "TOOL_RESULT")).toHaveLength(2);
    // 邻居的舱还活着（通道没被邻居的失败带走）
    expect(peer.cell.conn.isClosed).toBe(false);
  }, 120_000);
});
