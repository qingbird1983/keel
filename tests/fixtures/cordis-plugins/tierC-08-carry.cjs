// C 档 #8 的 after（产生方）：谁产生状态谁持有——值留在**自己这个舱**里，
// 要给别人的那一份从工具返回值里出去，由内核带到决策，再由决策作为入参发给对方。
// 插件全程不知道自己身处哪个会话（ctx.scope 读任何字段即抛），所以它也没法"按会话号找邻居"。
module.exports = function activate(ctx) {
  var owned = null; // 舱内私有：另一个会话的同一个插件文件也有它自己的一份，互不污染

  ctx.tools.register("note.new", {}, async function (params) {
    owned = { token: params.token, seenTimes: 1 };
    return { token: owned.token }; // ← 值经这条路径出去（内核唯一载体：工具结果 → 决策 → 下一轮入参）
  });

  // 自己这边的读面：证明状态确实留在本舱（不是"其实写到了别处"）
  ctx.tools.register("note.peek", {}, async function () {
    return { owned: owned };
  });
};
