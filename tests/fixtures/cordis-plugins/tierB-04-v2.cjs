// B 档样本 4 的新版（升级路径 B6 的目标）：flip 换实现（v2），并多注册一个 extra。
// 与 v1 同名不同实现 → 换绑后的新舱必须把 flip 顶到 v2，且 extra 只在新会话里可见（对照旧舱）。
module.exports = function activate(ctx) {
  ctx.tools.register('flip', { v: 2 }, function () {
    return { v: 2, from: 'legacy-v2' };
  });

  ctx.tools.register('extra', {}, function () {
    return { tool: 'extra' };
  });
};
