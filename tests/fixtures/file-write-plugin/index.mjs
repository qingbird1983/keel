// 受治理写文件样例（R3，ADR-0018）：handler 不直接碰 fs，也不写撤销代码。
// `ctx.workspace.create` 由宿主执行独占创建并签发收据；内置 fs.remove 只认这张收据。
export const tools = [
  {
    name: "write_file",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (params, ctx) => {
      const { path, content } = params;
      const r = await ctx.workspace.create({ path, content });
      return { path, bytes: r.bytes };
    },
  },
  {
    name: "overwrite_file",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (params, ctx) => {
      const { path, content } = params;
      const r = await ctx.workspace.overwrite({ path, content });
      return { path, bytes: r.bytes };
    },
  },
  {
    name: "write_two",
    schema: {
      type: "object",
      properties: {
        pathA: { type: "string" },
        pathB: { type: "string" },
      },
      required: ["pathA", "pathB"],
      additionalProperties: false,
    },
    handler: async (params, ctx) => {
      await ctx.workspace.create({
        path: params.pathA,
        content: "a",
        effectId: ctx.effects[0].effectId,
      });
      let second = true;
      try {
        await ctx.workspace.create({
          path: params.pathB,
          content: "b",
          effectId: ctx.effects[1].effectId,
        });
      } catch {
        second = false;
      }
      return { first: true, second };
    },
  },
  {
    name: "env_probe",
    schema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({
      secret: process.env.KEEL_TEST_SECRET ?? null,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      cwd: process.cwd(),
    }),
  },
];
