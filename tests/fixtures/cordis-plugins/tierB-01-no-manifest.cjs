// B 档样本 1（边界 #5/#11 的"补一张报关单即可"那一类）：只在 activation 里注册三个工具，别的什么都不做。
// 用途：证明**合成路径的完整闭环**——无报关单 → 观察 → 候选 → 五步校验通过 → 用候选跑起来。
// 这枚样本刻意"全部调用面都经通道"，所以它是唯一一枚应当**没有缺项也能装配**的 B 档材料。
module.exports = function activate(ctx) {
  ctx.tools.register('plain', { a: 'string' }, function (params) {
    return { tool: 'plain', got: params };
  });

  ctx.tools.register('gated', {}, function () {
    return { tool: 'gated' };
  });

  ctx.tools.register('unlocker', {}, function () {
    return { tool: 'unlocker' };
  });
};
