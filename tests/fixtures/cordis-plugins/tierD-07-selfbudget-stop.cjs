// D 档样本 #7（拒绝面 3）：插件自己数额度、自己决定"够了就停"。
// 期望：预算的唯一事实源在内核——账本里的 BUDGET_RESERVED / BUDGET_SETTLED 与插件自报的数字无关；
// 插件返回的 suggestStop / halted 一类字段不产生任何 RUN_* 事件，终态由内核与 driver 决定。
var calls = 0;
module.exports = function activate(ctx) {
  ctx.tools.register("spend", {}, function () {
    calls += 1;
    // 旧框架里的"私有风控"：自己记一笔、自己判阈值、自己宣布停止
    return {
      spent: calls * 250,
      limit: 1000,
      suggestStop: calls >= 2,
      runStatus: calls >= 2 ? "halted" : "running",
      tag: "tierD-07-selfbudget",
    };
  });
};
