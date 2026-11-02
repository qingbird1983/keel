// A 档样本 1（边界 #1）：activation 里用旧框架的两种调用形状注册工具，handler 留在插件侧执行。
// 零改动判据：CommonJS 书写习惯、不 import 任何内核包名、ctx 完全由承接层注入。
module.exports = function activate(ctx) {
  // 旧框架位置形：register(name, schema, handler)
  ctx.tools.register("echo", { type: "object" }, function (params) {
    return { echoed: params };
  });
  // 对象形
  ctx.tools.register({
    name: "sum",
    schema: { two: "number" },
    handler: function (params) {
      return { sum: params.a + params.b };
    },
  });
  ctx.tools.register("tag", {}, function () {
    return { tag: "tierA-01" };
  });
};
