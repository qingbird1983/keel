// A7 fixture：Cell 侧"直连"路径的 fail-closed 实测材料。
// 一个工具里走完四条路径：越权工具授权查询 / 越权模型调用 / 合法模型调用 / 同 reqId 重放。
// 插件手上没有凭证，也没有第二条网络通道——一切模型调用只能落在 Core 网关上。

export const tools = [
  {
    name: "probe-paths",
    schema: {},
    handler: async (_p, { client }) => {
      const toolAuth = await client.authCheck("tool.invoke", "forbidden-tool");

      let modelDeniedCode = "NOT-DENIED";
      try {
        await client.modelInvoke({
          reqId: "a7-bad",
          model: "gpt-bypass",
          params: {},
          estimate: 5,
        });
      } catch (err) {
        modelDeniedCode = err && err.code ? String(err.code) : String(err);
      }

      const good = await client.modelInvoke({
        reqId: "a7-good",
        model: "gpt-mini",
        params: { n: 1 },
        estimate: 100,
      });
      const again = await client.modelInvoke({
        reqId: "a7-good",
        model: "gpt-mini",
        params: { n: 1 },
        estimate: 100,
      });

      return {
        toolAllowed: toolAuth.allowed,
        modelDeniedCode,
        good,
        again: { cost: again.cost, replay: again.replay },
      };
    },
  },
];
