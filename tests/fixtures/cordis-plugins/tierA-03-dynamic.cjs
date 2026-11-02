// A 档样本 3（边界 #1 运行期动态面）：在 handler 里注册新工具、撤掉已有工具——
// 注册生效时刻 = 下一轮（内核在轮边界取走挂起变更，02 稿 §5.2）。
module.exports = function activate(ctx) {
  ctx.tools.register("boot", {}, function () {
    return { tool: "boot" };
  });

  ctx.tools.register("grow", {}, async function () {
    // 运行期加一个名字：本轮决策输入已定，它在下一轮才可见
    var view = await ctx.tools.register("late", { born: "runtime" }, function () {
      return { tool: "late" };
    });
    return { registered: view.name, schemaVersion: view.schemaVersion };
  });

  ctx.tools.register("shrink", {}, async function () {
    var removed = await ctx.tools.remove("boot");
    return { removed: removed };
  });
};
