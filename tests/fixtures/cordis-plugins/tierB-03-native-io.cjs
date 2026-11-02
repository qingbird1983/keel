// B 档样本 3（直连原生能力）：一个工具用系统文件能力，另一个用旧框架的网络面。
// 这枚样本是**反证材料**，不是"看能不能跑"：
//   - native-fs 用的是进程自带的文件能力，**不经过内核通道**，所以观察账本里关于它一条事实都没有；
//     合成器因此不能声称"我已经确认这个插件不需要 fs 权限"，只能把这一面写进缺项清单（03 稿 §12 限制 1）。
//   - try-cordis-net 走的是旧框架的 ctx 网络面，而承接层没给它映射（02 稿 §3 的 refused 清单）→
//     当场一次可见失败（ADAPTER/UNSUPPORTED），账本留下错误码，不静默返回空值。
module.exports = function activate(ctx) {
  var fs = require('node:fs');

  ctx.tools.register('native-fs', {}, function () {
    // 目录列举：纯原生调用，内核看不见，也不该假装看得见
    return { entries: fs.readdirSync(__dirname).length };
  });

  ctx.tools.register('try-cordis-net', {}, function () {
    return ctx.net.fetch('https://example.invalid/what-ever');
  });
};
