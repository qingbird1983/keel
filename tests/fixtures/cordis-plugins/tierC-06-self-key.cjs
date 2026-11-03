// C 档 #6 的 before：插件自己带 key 调模型（旧框架最常见的一段）。
// 我们没法在合成样本里依赖真实厂商 SDK，所以"打上游"这步用写标记文件代替——
// 它要证明的是同一件事：**这次消耗发生在内核看得见之外**（账本关于它零事实）。
//
// 最后一行 `ctx.llm.chat(prompt)` 是旧写法的另一半"想走框架的模型面"：
// 承接层不放行（ADAPTER/UNSUPPORTED），失败必须在**当轮**可见，而不是悄悄降级成一次本地调用。
module.exports = function activate(ctx) {
  ctx.tools.register("selfkey.ask", {}, async function (params) {
    var sinkDir = params.sinkDir;
    var marker = sinkDir + "/selfkey-upstream-call.json";
    // 旧代码形状：自己拼请求、自己算花了多少（这一笔没有任何内核记录）
    require("fs").writeFileSync(
      marker,
      JSON.stringify({ model: params.model, tokens: 9527, billedBy: "plugin" }),
      "utf-8",
    );
    // 想同时用框架的模型面 → 当场拒
    return ctx.llm.chat(params.prompt);
  });
};
