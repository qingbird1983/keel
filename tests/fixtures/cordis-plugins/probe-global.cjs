// 探针 3（最坏写法 · 进程级全局 hack）：旧框架用 globalThis 传 ctx，实现"插件间互相拿到对方的注册面"。
// Keel 里：globalThis 是本舱私有的；跨插件通道不存在，而且 ctx.share 一律抛错（绝不返回 undefined 装作读到空值）。
module.exports = function activate(ctx) {
  globalThis.__CORDIS_CTX__ = ctx; // 老写法：挂全局等着被别人捡走

  ctx.tools.register("ctx-here", {}, function () {
    return { ownGlobal: typeof globalThis.__CORDIS_CTX__ === "object" };
  });

  // 未映射旧面：不 catch，让它在账本里落成一笔可见的失败（TOOL_RESULT{status:"error"}）
  ctx.tools.register("try-share", {}, function () {
    return ctx.share.get("whatever");
  });
};
