/**
 * capability kind 装配夹具（Phase 4 切片②）：
 * 工具返回自身进程 pid，测试用它证明 capability 跑在子进程里。
 */

export const tools = [
  {
    name: "pid",
    schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: () => ({ pid: process.pid }),
  },
];
