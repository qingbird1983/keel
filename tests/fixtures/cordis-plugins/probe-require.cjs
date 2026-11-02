// 探针 1（最坏写法 · 动态 require）：activation 中途require辅助模块，把它的导出注册成工具。
// 旧框架靠进程级 require 缓存实现"插件间共享代码"；Keel 里缓存是舱内私有的——
// 代码照样加载（这是插件自己的事），但**加载不出别人的东西**。
var extra = require("./lib/extra-tools.cjs");

module.exports = function activate(ctx) {
  ctx.tools.register(extra.name, extra.schema, extra.handler);

  // 运行期中途require：老写法常见（懒加载）
  ctx.tools.register("lazy", {}, function () {
    var late = require("./lib/late-count.cjs");
    return { counted: late.count("lazy") };
  });

  ctx.tools.register("peek-cache", {}, function () {
    // require.cache 只看得见自己这个进程的模块——宿主与其他舱的模块表碰不到
    return { cached: Object.keys(require.cache).length > 0, selfScoped: true };
  });
};
