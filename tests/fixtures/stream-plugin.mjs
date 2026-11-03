// B7④ fixture（切片⑤）：舱内 `model.stream` 的三个面都从这里发起——
// 逐页取片（顺序与总用量）、主动取消（断流口径）、上游中途抛（闭环之后报错）。
// 新生态形状：`export const tools`，由默认入口 `packages/cell-runtime/dist/main.js` 装载。
//
// 为什么用真子进程而不是只靠单测：单测（`packages/core/test/gateway-stream.test.ts`）测网关的
// 记账不变式；这里测**跨通道之后它还成不成立**——分片要过 stdio 帧序列化、会话归属要在宿主侧
// 的 binding 上重新成立一次、错误要带着 code/detail 穿回舱内（穿不过来的错误等于
// "账本说这次结过账了，而调用方毫不知情"）。

export const tools = [
  {
    // 一直 next 到 done：把分片顺序、每页片数、终局计量原样交回给测试断言。
    name: "stream-all",
    schema: {},
    handler: async (params, { client }) => {
      const p = params ?? {};
      const first = await client.modelStreamStart({
        reqId: String(p.reqId ?? "req-all"),
        model: String(p.model ?? "m-stream"),
        params: { n: Number(p.n ?? 20) },
        estimate: Number(p.estimate ?? 50),
      });
      const seqs = first.chunks.map((c) => c.seq);
      const pages = [first.chunks.length];
      let page = first;
      while (!page.done) {
        page = await client.modelStreamNext(page.streamId, Number(p.pageSize ?? 4));
        for (const c of page.chunks) seqs.push(c.seq);
        pages.push(page.chunks.length);
      }
      return {
        streamId: first.streamId,
        seqs,
        pages,
        produced: page.produced,
        cost: page.cost ?? null,
        usage: page.usage ?? null,
        // 正常结束不写 truncated（追加字段缺省不写 = 旧读方看到的形状不变）
        truncated: page.truncated ?? null,
      };
    },
  },
  {
    // 取满一页就主动收摊：已交付部分结算，之后的 next 只是终局重放。
    name: "stream-cancel",
    schema: {},
    handler: async (params, { client }) => {
      const p = params ?? {};
      const first = await client.modelStreamStart({
        reqId: String(p.reqId ?? "req-cancel"),
        model: String(p.model ?? "m-stream"),
        params: { n: Number(p.n ?? 20) },
        estimate: Number(p.estimate ?? 50),
      });
      const delivered = first.chunks.length;
      const cancelled = await client.modelStreamCancel(first.streamId);
      const after = await client.modelStreamNext(first.streamId, 4);
      return {
        streamId: first.streamId,
        delivered,
        cancelled,
        afterChunks: after.chunks.length,
        afterDone: after.done,
        afterReplay: after.replay ?? false,
        afterTruncated: after.truncated ?? null,
      };
    },
  },
  {
    // 上游中途抛：舱内看到的是错误，不是"看起来完整的一页"。
    name: "stream-boom",
    schema: {},
    handler: async (params, { client }) => {
      const p = params ?? {};
      try {
        const page = await client.modelStreamStart({
          reqId: String(p.reqId ?? "req-boom"),
          model: String(p.model ?? "m-stream"),
          params: { boomAfter: Number(p.boomAfter ?? 2) },
          estimate: Number(p.estimate ?? 50),
        });
        return { threw: false, chunks: page.chunks.length };
      } catch (err) {
        const detail = (err && err.detail) || {};
        return {
          threw: true,
          code: err && err.code ? String(err.code) : null,
          reason: detail.reason ? String(detail.reason) : null,
          // 闭环事实随错误一起穿过来：调用方不必靠猜确认"这次花了多少"
          produced: detail.produced ?? null,
          cost: detail.cost ?? null,
        };
      }
    },
  },
  {
    // 对照舱：邻居的流式失败不该碰它（I2 不级联的观察位）。
    name: "ping",
    schema: {},
    handler: async () => ({ pong: true }),
  },
];
