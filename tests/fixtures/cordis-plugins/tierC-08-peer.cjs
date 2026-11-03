// C 档 #8/#12/#15 的 after（接收方，跑在**另一个会话**里）：
// 值的来路只有两条合法通道——工具调用入参（这里用的就是这条）与只读账本；
// 没有"共享袋"，也没有"事件总线"，所以本插件看不见对方舱里的东西，只能看见内核给它的那一份。
module.exports = function activate(ctx) {
  ctx.tools.register("note.audit", {}, async function (params) {
    var mine = (await ctx.tools.list()).map(function (t) {
      return t.name;
    });
    // 改法之一（#11/#12/#15 的共同出路）：确认这个 run 里发生过什么，读只读账本（仅本 run）
    var page = await ctx.ledger.read();
    return {
      got: params.token, // ← 产生方那轮的返回值，经决策传进来（跨舱传递的唯一合法载体）
      visibleHere: mine,
      ledgerTypes: page && page.events ? page.events.map(function (e) { return e.type; }) : [],
    };
  });

  ctx.tools.register("note.noise", {}, async function () {
    return { quiet: true };
  });
};
