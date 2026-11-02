// B 档样本 4 的旧版（升级路径 B6 的起点）：只注册一个 flip，返回 v1。
// 刻意做成"进程内状态极简"的样子：旧插件的跨版本状态迁移需要作者知识，承接层不代它实现（03 稿 §5）。
module.exports = function activate(ctx) {
  ctx.tools.register('flip', { v: 1 }, function () {
    return { v: 1, from: 'legacy-v1' };
  });
};
