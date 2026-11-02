// 新生态形状（对照用）：export const tools 由 @keel/cell-runtime 默认入口装载进执行表。
// 它不参与 A 档零改动扫描（不是存量插件形状），只证明"换入口"与"默认入口"可共存。
export const tools = [
  {
    name: "m-echo",
    schema: { type: "object" },
    handler: (params) => ({ modern: params }),
  },
];
