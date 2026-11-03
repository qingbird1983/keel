// B7① 用的旧形状工具集（切片④）：三个 handler 各自把"我跑过"写进 params.sink 指定的文件。
// 为什么要有这个文件之外的记号：策略挡住的动作必须能证明**一次都没执行**——只看账本的话，
// "TOOL_RESULT 里写着 error" 与 "handler 其实跑了但抛错" 是分辨不了的（sink 里没有这一行才是凭据）。
module.exports = function activate(ctx) {
  var fs = require("fs");
  function note(sink, line) {
    fs.appendFileSync(sink, line + "\n", "utf-8");
  }
  ctx.tools.register("mark", {}, function (params) {
    note(params.sink, "mark");
    return { marked: true };
  });
  ctx.tools.register("transfer", {}, function (params) {
    note(params.sink, "transfer");
    return { sent: params.amount };
  });
  // 每次都失败的工具：hook③（重试建议）的触发条件是 TOOL_RESULT{status:"error"}
  ctx.tools.register("flaky", {}, function (params) {
    note(params.sink, "flaky");
    throw new Error("flaky-always-fails");
  });
};
