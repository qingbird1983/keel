// 反例（能力未报关）：插件照旧注册工具，但它这份报关单里没有 tool.provide。
// 期待不是"凑合跑"，而是当场可见失败：内核裁决拒绝 → 舱内注册抛错 → activation 失败 →
// 本 Cell 非零退出（RUN_FAILED{CELL/CRASH}），账本里留着 AUTH_DENIED 的拒绝归因。
module.exports = async function activate(ctx) {
  await ctx.tools.register("should-not-appear", {}, function () {
    return { tool: "should-not-appear" };
  });
  // 走不到这里：上一行就被内核挡下
  ctx.tools.register("also-absent", {}, function () {
    return { tool: "also-absent" };
  });
};
