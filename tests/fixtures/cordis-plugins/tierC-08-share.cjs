// C 档 #8 的 before：把状态写进"共享上下文"，指望另一个插件读到（旧框架最难查的污染源）。
// 这里两件事都要成立才算诚实：
//   1) `ctx.share.set` 当场拒（ADAPTER/UNSUPPORTED）——不是"写了但看不见"；
//   2) 拒绝发生在**写之前**，所以没有任何一半落到别处（半写状态是旧框架最常见的事故形态）。
module.exports = function activate(ctx) {
  ctx.tools.register("note.try-share", {}, async function (params) {
    var local = { token: params.token, stamped: Date.now() };
    // 旧写法：塞进共享袋，让别人去读
    ctx.share.set("peer-key", local);
    // 走不到这里（上一行就抛）；留着是为了证明"半写"没有发生
    return { written: true, value: local };
  });
};
