// 探针 2/3/1 的作用域对照插件：与主探针同时跑在**另一个会话**里，只看不写。
// 三个"看"就是三条负向证据：原型补丁没溢过来 / 全局 ctx 没溢过来 / require 缓存没溢过来。
module.exports = function activate(ctx) {
  ctx.tools.register("peer-quiet", {}, function () {
    return {
      protoLeak: typeof Array.prototype.last === "function",
      ctxLeak: globalThis.__CORDIS_CTX__ !== void 0,
      // 本进程的 require.cache 只含自己加载过的模块（探针 1 加载了 extra/late，这里没有）
      requiredLeak: Object.keys(require.cache).some(function (k) {
        return k.indexOf("extra-tools") >= 0;
      }),
    };
  });
};
