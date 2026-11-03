// D 档样本 #7/#14（拒绝面 1）：能力插件在运行期挂策略钩子——老框架里"顺手装个审批"的写法。
// 期望：承接层不映射钩子面（01 稿 #2 拆支归 #14），调用即抛 ADAPTER/UNSUPPORTED 并给出改法去处；
// 本 run 的账本里 HOOK_CALLED 恒为 0——被拒的那次注册没有部分生效。
module.exports = function activate(ctx) {
  ctx.tools.register("ok", {}, function () {
    return { ok: true };
  });
  ctx.tools.register("try.hook", {}, function () {
    // 故意用旧框架的钩子通道；这里不存在"退化为不装钩子继续跑"的路径
    return ctx.hooks.register("toolApproval", function () {
      return { verdict: "deny" };
    });
  });
};
