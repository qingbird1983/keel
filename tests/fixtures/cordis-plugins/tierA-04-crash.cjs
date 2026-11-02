// A 档样本 4（边界 #10）：旧框架"try/catch 吞掉异常保平安"的写法 + 一处逃逸到进程外的异常。
// 语义变化要知晓：吞掉的那处仍是插件自己的事；**逃逸的那处从此是可见事件**——
// 本 Cell 非零退出 → 该 run 落 RUN_FAILED{CELL/CRASH}，舱外不受影响（Phase 1 A2 同族主张）。
module.exports = function activate(ctx) {
  try {
    // 旧习惯：装配期的小错就地吞掉（不改变任何内核事实）
    var nothing = null;
    nothing.deep();
  } catch (e) {
    // 忽略
  }

  ctx.tools.register("safe", {}, function () {
    return { tool: "safe" };
  });

  ctx.tools.register("boom", {}, function () {
    // 不在返回的承诺里，而是脱离调用栈抛出：未捕获异常 = 进程退出（承接层入口的崩溃语义）
    setImmediate(function () {
      throw new Error("legacy plugin escaped exception");
    });
    return { tool: "boom", scheduled: true };
  });
};
