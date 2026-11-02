// A2 fixture：注入抛未捕获异常的插件（tests/cell-crash.test.ts 用）
// handler 保持在途直到崩溃发生，保证 crash 落在工具请求在途窗口（确定性）
export const tools = [
  {
    name: "boom",
    schema: { type: "object" },
    handler: () => {
      setTimeout(() => {
        throw new Error("boom: uncaught plugin failure");
      }, 10);
      return new Promise((resolve) => setTimeout(resolve, 300));
    },
  },
];
