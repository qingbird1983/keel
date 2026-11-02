// A 档样本 2（边界 #1 覆盖语义）：同名重复注册 = 更新，版本号由内核 +1（插件侧不自算）。
// 另一会话对同名工具各记各的版本，这一笔在 tier-a 测试里用第二个会话交叉核对。
module.exports = async function activate(ctx) {
  ctx.tools.register("flip", { v: 1 }, function () {
    return { v: 1 };
  });
  // await 是这一面对 Keel 的真实让步（02 稿 §6：跨进程问内核就是一次往返）
  var second = await ctx.tools.register("flip", { v: 2 }, function () {
    return { v: 2 };
  });
  // 把内核指派的版本作为工具结果暴露出来，测试据此断言"版本单一事实源"
  ctx.tools.register("reported", {}, function () {
    return { schemaVersion: second.schemaVersion, name: second.name };
  });
};
