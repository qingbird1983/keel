// A2 fixture：正常插件（对照组——其他会话不受崩溃影响）
export const tools = [
  {
    name: "ok",
    schema: { type: "object" },
    handler: (p) => ({ done: true, echoed: p }),
  },
];
