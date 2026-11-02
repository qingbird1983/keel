// A 档样本 2 的作用域对照插件：**同名**工具只注册一次。
// 与 tierA-02-overwrite 同时跑在两个会话里 → 一边 flip@2、一边 flip@1，
// 版本按 scope 各自记（旧框架的全局表在这里结构上不可能存在）。
module.exports = function activate(ctx) {
  ctx.tools.register("flip", { v: 1, from: "peer" }, function () {
    return { v: 1, from: "peer" };
  });
};
