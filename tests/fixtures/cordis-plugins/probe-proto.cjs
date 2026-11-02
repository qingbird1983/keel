// 探针 2（最坏写法 · 原型链猴子补丁）：旧框架插件普遍这么"给全进程加能力"。
// Keel 里补丁的作用域 = 本进程 = 本舱；邻居会话与宿主都碰不到（探针 peer 负责证伪"外溢"）。
module.exports = function activate(ctx) {
  // 这行本身就是被测的旧写法（eslint 对这批样本关掉 no-extend-native，见 eslint.config.js）
  Array.prototype.last = function () {
    return this[this.length - 1];
  };

  ctx.tools.register("use-patch", {}, function () {
    return { last: [1, 2, 3].last() };
  });

  ctx.tools.register("patch-here", {}, function () {
    return { patched: typeof Array.prototype.last === "function" };
  });
};
