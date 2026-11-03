// C 档 #9 的 after：动手**前**报关，收尾办法事先写好。
// 这是本行唯一"改两处"的改法：manifest 补 compensation.templates（动作与幂等口径在那里），
// 代码把"动手后 reclaim"换成"动手前 declare"（只报关我动了什么、动了哪个目标）。
module.exports = function activate(ctx) {
  ctx.tools.register("side.write", {}, async function (params) {
    var fs = require("fs");
    // effectKind 必须命中报关单里的模板；effectId / 用哪个补偿动作都不由插件决定（C-M1）
    await ctx.effects.declare({
      effectKind: "fs.write.done",
      // 补偿动作在**另一个进程**里执行，靠这个摘要定位目标
      targetSummary: params.sinkFile,
      paramsDigest: { bytes: params.text.length },
    });
    fs.writeFileSync(params.sinkFile, params.text, "utf-8");
    // 动手之后失败：撤不撤、怎么撤由内核的补偿状态机决定，插件不参与编排
    throw new Error("boom-after-effect");
  });
};

// 旧形状能表达的补偿表：actionRef → 执行体（承接层装载时登记，不代造、不翻译 reclaim）。
// 必须容忍目标不存在——补偿可能被重放（状态机 §6）。
module.exports.compensations = {
  "undo-write": async function (input) {
    var fs = require("fs");
    var target = String(input.targetSummary);
    var existed = fs.existsSync(target);
    if (existed) fs.rmSync(target);
    fs.appendFileSync(
      target + ".undo",
      JSON.stringify({ effectId: input.effectId, phase: input.phase, existed: existed }) + "\n",
      "utf-8",
    );
    return { undone: true, existed: existed };
  },
};

// 私有状态索取面：旧插件也能把状态交给宿主（本片只登记，物理持久化在切片⑤）。
module.exports.snapshot = function () {
  return { phase: "declared-writer" };
};
