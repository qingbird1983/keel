/**
 * 流式网关单测（切片⑤ §3.4 / ADR-0013）—— 主张就是那四条记账不变式 + 断流口径：
 * 授权一次、预扣一次、`MODEL_INVOKED` 一条（含 `streamId`）、**每片不写事件**、
 * 终了 `MODEL_USAGE` + settle。断流按已产出部分结算（`truncated:true`），一片都没出 = 失败但仍闭环。
 *
 * 时限注入位（`streamWaitMs` / `streamDeadlineMs`）是测试缝，默认值 = 契约 §7 的 30s / 300s；
 * 这里把等待压到几十毫秒，断流路径才跑得动（否则一条测试真等 30 秒）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Authorizer, type AuthPolicyInput } from "../src/authorizer.js";
import { Budgeter } from "../src/budget.js";
import { ModelGateway, type ModelUpstream } from "../src/gateway.js";
import { Ledger } from "../src/ledger.js";
import type { StreamPart } from "../src/stream.js";
import { STREAM_DEFAULT_LIMIT, STREAM_MAX_BUFFERED } from "../src/stream.js";
import type { RunRef } from "../src/events.js";

let dir: string;
const ledgers: Ledger[] = [];
const ref: RunRef = { agentId: "agent-1", sessionId: "sess-1", runId: "run-1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-gws-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const policyAllow: AuthPolicyInput = {
  version: "p1",
  allow: [
    { subject: "cell-1", action: "model.invoke", resource: "model-x" },
    { subject: "cell-1", action: "model.stream", resource: "model-x" },
  ],
};

/** 只给 invoke 不给 stream：流式当场被拒（授权动作是两条，不是一条的通配）。 */
const policyInvokeOnly: AuthPolicyInput = {
  version: "p1",
  allow: [{ subject: "cell-1", action: "model.invoke", resource: "model-x" }],
};

function parts(n: number, cost = 1): StreamPart[] {
  return Array.from({ length: n }, (_, i) => ({
    chunk: { seq: i + 1, text: `c${String(i + 1)}` },
    cost,
    usage: { parts: i + 1, tokens: (i + 1) * 4 },
  }));
}

function harness(
  upstream: ModelUpstream,
  opts: { policy?: AuthPolicyInput; streamWaitMs?: number; streamDeadlineMs?: number } = {},
) {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  const auth = new Authorizer(opts.policy ?? policyAllow, ledger);
  const budget = new Budgeter(ledger);
  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream,
    ...(opts.streamWaitMs !== undefined ? { streamWaitMs: opts.streamWaitMs } : {}),
    ...(opts.streamDeadlineMs !== undefined ? { streamDeadlineMs: opts.streamDeadlineMs } : {}),
  });
  return { ledger, auth, budget, gateway };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一个可控上游：分片之间可选停顿，并记录被打开过几次（幂等主张要看这个计数）。 */
function fakeStream(chunks: StreamPart[], gapMs = 0) {
  let opened = 0;
  const upstream: ModelUpstream = {
    invoke: async () => ({ result: {}, usage: {}, cost: 0 }),
    async *stream() {
      opened++;
      for (const p of chunks) {
        if (gapMs > 0) await sleep(gapMs);
        yield p;
      }
    },
  };
  return { upstream, openedCount: () => opened };
}

const req = { reqId: "req-s1", model: "model-x", params: { q: "hi" }, estimate: 20 };

describe("model.stream（ADR-0013：拉式分片 + 四条记账不变式）", () => {
  it("一次调用 = 一条 MODEL_INVOKED（含 streamId）+ 一条 MODEL_USAGE：分片不写事件", async () => {
    const { upstream, openedCount } = fakeStream(parts(3));
    const { ledger, gateway } = harness(upstream);
    const first = await gateway.streamStart(ref, "cell-1", req);
    expect(first.chunks).toHaveLength(3);
    expect(first.done).toBe(true); // 上游三片后自然结束 → 首页即终页
    expect(first.cost).toBe(3);
    expect(openedCount()).toBe(1);

    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.map((e) => e.type)).toEqual([
      "BUDGET_RESERVED", // 预扣一次
      "MODEL_INVOKED",
      "BUDGET_SETTLED",
      "MODEL_USAGE",
    ]);
    const invoked = evs.find((e) => e.type === "MODEL_INVOKED")!;
    expect(invoked.payload).toMatchObject({ reqId: "req-s1", streamId: first.streamId });
    // 每片不写事件：三片与三十片的**事件条数相同**（否则账本体积 = 流长度的函数）
    expect(invoked.schemaVersion).toBe(2); // 类型级版本表：追加字段的类型才升
    const usage = evs.find((e) => e.type === "MODEL_USAGE")!;
    expect(usage.payload).toMatchObject({ reqId: "req-s1", cost: 3 });
    expect("truncated" in (usage.payload as object)).toBe(false); // 正常结束不写这字段
    // 权威计量 3、预扣 20 → 退 17
    expect(evs.find((e) => e.type === "BUDGET_SETTLED")!.payload).toMatchObject({
      actual: 3,
      refund: 17,
    });
  });

  it("分页取片：默认页上限 16，limit 可再小；produced 跨页累计，顺序 = 上游产出顺序", async () => {
    const { upstream } = fakeStream(parts(20)); // 全部即时可得 → 这条测的是分页而不是时序
    const { gateway } = harness(upstream);
    const a = await gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-page2" });
    expect(a.chunks).toHaveLength(16); // STREAM_DEFAULT_LIMIT
    expect(a.done).toBe(false);
    const b = await gateway.streamNext(ref, "cell-1", a.streamId, 4);
    expect(b.chunks).toHaveLength(4);
    expect(b.produced).toBe(20);
    expect(b.done).toBe(false); // 页取满了，但上游还没结束
    const c = await gateway.streamNext(ref, "cell-1", a.streamId, 4);
    expect(c.done).toBe(true); // 再取 = 上游结束 → 正常终局（不是截断）
    expect("truncated" in c).toBe(false);
    const seqs = [...a.chunks, ...b.chunks, ...c.chunks].map((x) => (x as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("断流（上游挂住超过等待上限）：已产出部分结算 + truncated:true", async () => {
    const stalling: ModelUpstream = {
      invoke: async () => ({ result: {}, usage: {}, cost: 0 }),
      async *stream() {
        yield { chunk: "a", cost: 2 };
        yield { chunk: "b", cost: 3 };
        await sleep(10_000); // 第三片永远不来（测试里等 40ms 就判定断流）
      },
    };
    const { ledger, gateway } = harness(stalling, { streamWaitMs: 40 });
    const page = await gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-stall" });
    expect(page.chunks).toEqual(["a", "b"]);
    expect(page.done).toBe(true);
    expect(page.truncated).toBe(true);
    expect(page.cost).toBe(5); // 已产出部分的权威计量，不假装这次调用没花钱
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.find((e) => e.type === "MODEL_USAGE")!.payload).toMatchObject({
      reqId: "req-stall",
      cost: 5,
      truncated: true,
    });
    // 预扣 20、实结 5 → 退 17（断流不吞掉剩余，也不全额退还）
    expect(evs.find((e) => e.type === "BUDGET_SETTLED")!.payload).toMatchObject({
      actual: 5,
      refund: 15,
    });
  });

  it("一片都没出的断流 = 失败（GATEWAY/UPSTREAM-ERROR），但仍然 settle 闭环不留悬空预扣", async () => {
    const stalling: ModelUpstream = {
      invoke: async () => ({ result: {}, usage: {}, cost: 0 }),
      async *stream() {
        await sleep(10_000);
        yield { chunk: "late", cost: 1 };
      },
    };
    const { ledger, gateway } = harness(stalling, { streamWaitMs: 40 });
    await expect(
      gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-zero" }),
    ).rejects.toMatchObject({ code: "GATEWAY/UPSTREAM-ERROR", detail: { reason: "STREAM_STALL" } });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    // 有 MODEL_INVOKED（调用确实发起过）、有 settle(0)（不悬空）、有 truncated 的 MODEL_USAGE
    expect(evs.map((e) => e.type)).toEqual([
      "BUDGET_RESERVED",
      "MODEL_INVOKED",
      "BUDGET_SETTLED",
      "MODEL_USAGE",
    ]);
    expect(evs.find((e) => e.type === "BUDGET_SETTLED")!.payload).toMatchObject({ actual: 0 });
    expect(evs.find((e) => e.type === "MODEL_USAGE")!.payload).toMatchObject({
      cost: 0,
      truncated: true,
    });
  });

  it("会话总长到期同样走断流口径（deadline 注入位）", async () => {
    const endless: ModelUpstream = {
      invoke: async () => ({ result: {}, usage: {}, cost: 0 }),
      async *stream() {
        for (;;) {
          yield { chunk: "tick", cost: 1 };
          await sleep(10);
        }
      },
    };
    const { ledger, gateway } = harness(endless, { streamWaitMs: 500, streamDeadlineMs: 40 });
    const page = await gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-deadline" });
    expect(page.truncated).toBe(true);
    expect(page.done).toBe(true);
    const usage = (await ledger.read({ runId: ref.runId })).events.find(
      (e) => e.type === "MODEL_USAGE",
    );
    expect(usage!.payload).toMatchObject({ truncated: true });
  });

  it("cancel：主动收摊 = 已产出部分结算 + truncated；重复 cancel 幂等", async () => {
    // 上游先瞬出满页片数，之后挂住不来：start 返回**一满页**（默认页上限 16），会话还活着
    const burst: ModelUpstream = {
      invoke: async () => ({ result: {}, usage: {}, cost: 0 }),
      async *stream() {
        for (const p of parts(STREAM_MAX_BUFFERED)) yield p;
        await sleep(10_000);
      },
    };
    const { ledger, gateway } = harness(burst, { streamWaitMs: 2_000 });
    const first = await gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-cancel" });
    expect(first.done).toBe(false); // 一满页，会话没到终局
    expect(first.chunks).toHaveLength(STREAM_DEFAULT_LIMIT); // 页上限截住，不是缓冲上限
    const cancelled = await gateway.streamCancel(ref, "cell-1", first.streamId);
    // cancel 结算的是**已交付给调用方的那部分**（一满页 = 16 片 × cost 1），挂住没出的不算钱
    expect(cancelled).toMatchObject({
      settled: true,
      truncated: true,
      cost: STREAM_DEFAULT_LIMIT,
    });
    const again = await gateway.streamCancel(ref, "cell-1", first.streamId);
    expect(again.cost).toBe(cancelled.cost); // 幂等：第二次不重复结算
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.filter((e) => e.type === "MODEL_USAGE")).toHaveLength(1); // 只结一次
    // cancel 之后再取片 = 终局重放（不重打上游、不重复扣）
    const after = await gateway.streamNext(ref, "cell-1", first.streamId, 4);
    expect(after).toMatchObject({ done: true, replay: true, chunks: [] });
  });

  it("同 reqId 重放：命中已终会话返回同一 streamId + replay，不重打上游、不重复预扣", async () => {
    const slow = fakeStream(parts(2));
    const { ledger, gateway } = harness(slow.upstream);
    const a = await gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-idem" });
    expect(a.chunks).toHaveLength(2);
    expect(a.done).toBe(true);
    const b = await gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-idem" });
    expect(b.streamId).toBe(a.streamId);
    expect(b.replay).toBe(true);
    expect(b.chunks).toEqual([]); // 不重放内容（决策 5：流式不重放）
    expect(slow.openedCount()).toBe(1); // 上游只被打过一次
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.filter((e) => e.type === "BUDGET_RESERVED")).toHaveLength(1); // 预扣也只一次
    expect(evs.filter((e) => e.type === "MODEL_USAGE")).toHaveLength(1); // 结算一次
  });

  it("上游中途抛：账本仍是断流口径（一条 MODEL_USAGE + 一次 settle），但调用面报错不返半截页", async () => {
    const boom: ModelUpstream = {
      invoke: async () => ({ result: {}, usage: {}, cost: 0 }),
      async *stream() {
        yield { chunk: "a", cost: 2 };
        yield { chunk: "b", cost: 3 };
        throw new Error("upstream exploded");
      },
    };
    const { ledger, gateway } = harness(boom);
    // 为什么不是"把已产出的两片连同 done:true 一起返回"：上游明确失败了，
    // 半截答案标成完整回答 = 静默降级（07 稿 §9 第 5 条的口径在读方一侧的落点）。
    await expect(
      gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-throw" }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "STREAM_UPSTREAM_THROW", produced: 2, cost: 5, cause: "upstream exploded" },
    });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.map((e) => e.type)).toEqual([
      "BUDGET_RESERVED",
      "MODEL_INVOKED",
      "BUDGET_SETTLED",
      "MODEL_USAGE",
    ]);
    // 已产出部分的权威计量照常结算（不假装这次调用没花钱，也不全额退还）
    expect(evs.find((e) => e.type === "BUDGET_SETTLED")!.payload).toMatchObject({
      actual: 5,
      refund: 15,
    });
    expect(evs.find((e) => e.type === "MODEL_USAGE")!.payload).toMatchObject({
      cost: 5,
      truncated: true,
    });
  });

  it("一片都没出时上游抛：settle(0) 全额退还 + truncated 用量留痕，错误照抛", async () => {
    const boom: ModelUpstream = {
      invoke: async () => ({ result: {}, usage: {}, cost: 0 }),
      // 一片都没出：第一次 next() 就拒绝的 iterable（写成 generator 会触发 require-yield）
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("handshake failed")),
        }),
      }),
    };
    const { ledger, gateway } = harness(boom);
    await expect(
      gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-throw0" }),
    ).rejects.toMatchObject({ code: "GATEWAY/UPSTREAM-ERROR", detail: { produced: 0, cost: 0 } });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.find((e) => e.type === "BUDGET_SETTLED")!.payload).toMatchObject({
      actual: 0,
      refund: 20,
    });
    expect(evs.filter((e) => e.type === "MODEL_USAGE")).toHaveLength(1);
  });

  it("未声明 model.stream 授权 → AUTH/DENIED，零预扣零 MODEL_INVOKED", async () => {
    const { upstream, openedCount } = fakeStream(parts(2));
    const { ledger, gateway } = harness(upstream, { policy: policyInvokeOnly });
    await expect(
      gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-deny" }),
    ).rejects.toMatchObject({ code: "AUTH/DENIED" });
    expect(openedCount()).toBe(0);
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.map((e) => e.type)).toEqual(["AUTH_DENIED"]); // 拒绝必留痕，且只有这一条
    expect(evs.filter((e) => e.type === "MODEL_INVOKED")).toEqual([]);
  });

  it("上游不支持流式 → 显式失败（不降级为非流式）+ settle(0) 退还预扣", async () => {
    const noStream: ModelUpstream = { invoke: async () => ({ result: 1, usage: {}, cost: 0 }) };
    const { ledger, gateway } = harness(noStream);
    await expect(
      gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-nos" }),
    ).rejects.toMatchObject({
      code: "GATEWAY/UPSTREAM-ERROR",
      detail: { reason: "UPSTREAM_NO_STREAM" },
    });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.map((e) => e.type)).toEqual(["BUDGET_RESERVED", "MODEL_INVOKED", "BUDGET_SETTLED"]);
    expect(evs.at(-1)!.payload).toMatchObject({ actual: 0, refund: 20 }); // 全额退还
    expect(evs.filter((e) => e.type === "MODEL_USAGE")).toEqual([]); // 没有用量就没有完成
  });

  it("streamId 是标识符不是权限：别人的会话与不存在的会话同样回答（不留探测信道）", async () => {
    const { upstream } = fakeStream(parts(2));
    const { gateway } = harness(upstream);
    const mine = await gateway.streamStart(ref, "cell-1", { ...req, reqId: "req-own" });
    const otherRun: RunRef = { agentId: "agent-1", sessionId: "sess-1", runId: "run-2" };
    await expect(gateway.streamNext(otherRun, "cell-1", mine.streamId)).rejects.toMatchObject({
      code: "SCHED/NOT-FOUND",
    });
    await expect(gateway.streamNext(ref, "cell-2", mine.streamId)).rejects.toMatchObject({
      code: "SCHED/NOT-FOUND",
    });
    await expect(gateway.streamNext(ref, "cell-1", "stm-999-nope")).rejects.toMatchObject({
      code: "SCHED/NOT-FOUND",
    });
  });
});
