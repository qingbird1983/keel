// C 档 #9 的 before：先动手，出事再说——`effects.reclaim` 正是旧框架里"临场决定怎么收尾"的那一面。
// 两件事都要成立才算诚实：
//   1) 副作用真的发生了（写文件；当前进程后端不拦截舱内原生 fs，这是 02 稿 F4 登记的既有限制）；
//   2) reclaim 当场拒（ADAPTER/UNSUPPORTED），于是账本里**既没有 EFFECT_DECLARED 也没有补偿痕迹**——
//      那个副作用从此没人知道怎么撤，正是旧框架最难收的场。
module.exports = function activate(ctx) {
  ctx.tools.register("side.write", {}, async function (params) {
    var fs = require("fs");
    fs.writeFileSync(params.sinkFile, params.text, "utf-8");
    // 旧写法：临时编一个"回收"动作交给框架
    ctx.effects.reclaim("effect-" + params.tag);
    // 走不到这里（上一行就抛）：留着证明没有"半回收"这种中间态
    fs.writeFileSync(params.sinkFile + ".undone", "", "utf-8");
    return { written: true };
  });
};
