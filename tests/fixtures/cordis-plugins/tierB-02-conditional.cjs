// B 档样本 2（注册面含条件分支）：activation 只注册三个名字，第四个要等某个 handler 被真正调用过才出现。
// 这是旧插件里极常见的写法（懒注册 / 按参数装配），用来压两件事：
//   ① 一趟观察**看不全**调用面——第一趟只拿到三个名字，运行期注册第四个会被当场拒（它不在候选的 allow 里）；
//   ② 被拒这件事本身是第二条观察事实——合成器据此把第四名追加进候选，但仍要人工审核才转正。
// 注意 unlocker 里是 await：被拒时它落成一次可见的工具失败（TOOL_RESULT{status:"error"}），
// 而不是脱管的 Promise（那会让本舱崩，见 tierA-04 的另一条主张）。
module.exports = function activate(ctx) {
  ctx.tools.register('plain', {}, function () {
    return { tool: 'plain' };
  });

  ctx.tools.register('gated', {}, function () {
    return { tool: 'gated' };
  });

  ctx.tools.register('unlocker', {}, async function () {
    var view = await ctx.tools.register('bonus', { born: 'inside-handler' }, function () {
      return { tool: 'bonus' };
    });
    return { registered: view.name, schemaVersion: view.schemaVersion };
  });
};
