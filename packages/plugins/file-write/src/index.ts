/**
 * 插件 B `file-write`（Phase 3 三件套，08 稿 §4.3）——受治理的新建写工具。
 *
 * 零 import（扫描判据 B4-deps 禁任何依赖声明，含 @keel/* 类型；类型按结构满足，
 * 与插件 A echo 同理）；守卫 / 副作用声明 / 补偿全部由 manifest `governance` +
 * `compensation` 模板驱动（ADR-0015/0016），handler 只做一件事：
 * `ctx.workspace.create` 独占创建（ADR-0018），收据由宿主核对路径与身份后签发。
 * 覆盖写不在本工具语义内：`create` 对已存在目标报 `WORKSPACE/EXISTS`（ADR-0020），
 * "补偿 = 删除本次创建的文件"因此与收据语义自洽。
 */

type WriteParams = { path: string; content: string };
type WorkspaceHandle = {
  create(args: { path: string; content: string }): Promise<{ bytes: number }>;
};

export const tools = [
  {
    name: "write_file",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (params: WriteParams, ctx: { workspace: WorkspaceHandle }) => {
      const r = await ctx.workspace.create({ path: params.path, content: params.content });
      return { path: params.path, bytes: r.bytes };
    },
  },
];
