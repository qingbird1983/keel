/**
 * 插件 A `echo`（Phase 3 三件套，03 稿 §5.3）——只读工具：原样返回输入文本。
 *
 * 零 import（03 稿 F5：扫描判据 B4-deps 禁任何依赖声明，含 @keel/* 类型）；
 * `CellTool` 形状按结构满足（类型定义持于宿主入口 cell-runtime/src/main.ts）。
 * 无 snapshot/compensations/migrate 导出 = 无状态 Cell（契约既有口径）。
 */

export const tools = [
  {
    name: "echo",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    handler: (params: unknown) => ({ echoed: (params as { text: string }).text }),
  },
];
