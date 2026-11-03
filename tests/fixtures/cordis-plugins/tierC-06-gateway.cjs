// C 档 #6 的 after：删掉"自己带 key 调上游 + 自己记账"那一段，改成走网关一次。
// 只改这一小段（代码确实动了，所以它是 C 档）；请求号 **reqId 由插件给**——
// 同一个 reqId 重发不重复计费，这是这段改法唯一不能省的地方（自动生成等于每次都是新请求）。
module.exports = function activate(ctx) {
  ctx.tools.register("gateway.ask", {}, async function (params) {
    var req = { model: params.model, params: { prompt: params.prompt }, estimate: params.estimate };
    var first = await ctx.model.invoke(params.reqId, req);
    // 旧代码里的"网络抖了就再打一次"：同一个 reqId → 内核命中已结算调用，不再打上游
    var retry = await ctx.model.invoke(params.reqId, req);
    return {
      first: { cost: first.cost, usage: first.usage, replay: first.replay },
      retry: { cost: retry.cost, usage: retry.usage, replay: retry.replay },
    };
  });
};
