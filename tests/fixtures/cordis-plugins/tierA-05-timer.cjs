// A 档样本 5（边界 #13）：插件内常驻定时器 + 两种"慢"的工具——同步忙等与永不落定的异步挂起。
// 旧框架里这类写法拖住的是主进程；Keel 里它只拖住自己那个舱：
//   忙等 = 本舱 CPU（邻居会话的轮次耗时不受影响，由 tier-a 测试交叉断言）；
//   挂起 = toolCallTimeoutMs 到点落一条 status:"timeout"（C-D3 的硬强制），不是静默消失。
// ticks 用来证明定时器在这个舱里持续跑：quick 让出一次事件循环（旧代码里也常见这种 await），
// 于是断言不依赖"这次刚好跳到了一下"。
module.exports = function activate(ctx) {
  var ticks = 0;
  // 旧框架常见的轮询：clearInterval 由进程退出兜底（舱死即停，不遗留全局负载）
  setInterval(function () {
    ticks += 1;
  }, 20);

  ctx.tools.register("busy", {}, function () {
    // 同步忙等约 250ms：占的是本 Cell 的 CPU（在 toolCallTimeoutMs 之内，所以仍算一次成功）
    var until = Date.now() + 250;
    while (Date.now() < until) {
      /* spin */
    }
    return { tool: "busy", spun: true };
  });

  ctx.tools.register("hang", {}, function () {
    // 远超 toolCallTimeoutMs 的异步等待：到点必须落一条可见的 timeout（不静默、也不取消 handler）
    return new Promise(function () {
      setTimeout(function () {}, 60000);
    });
  });

  ctx.tools.register("quick", {}, async function () {
    await new Promise(function (r) {
      setTimeout(r, 40);
    });
    return { tool: "quick", ticks: ticks };
  });
};
