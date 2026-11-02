// 探针 4（最坏写法 · 加载顺序依赖）：旧框架里插件按启动顺序往全局表塞东西，
// 后来者直接指望"前面那个插件已经把 beta-peer 注册好了"。
// Keel 里两件事同时成立：① 本舱可见表只含自己注册的名字（顺序无关，内容稳定）；
// ② 期待来自别处的工具 = 缺席，而不是污染——点名它会在账本里落成一次明确的失败。
module.exports = function activate(ctx) {
  // 故意反序注册：可见表内容不该受注册顺序影响
  ctx.tools.register("zeta", {}, function () {
    return { tool: "zeta" };
  });
  ctx.tools.register("alpha", {}, function () {
    return { tool: "alpha" };
  });

  ctx.tools.register("expect-peer", {}, async function () {
    var visible = (await ctx.tools.list()).map(function (t) {
      return t.name;
    });
    return { visible: visible, hasBetaPeer: visible.indexOf("beta-peer") >= 0 };
  });
};
