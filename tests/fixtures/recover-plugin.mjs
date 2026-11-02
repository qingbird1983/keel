// A3 fixture：有状态插件——snapshot() 索取面（宿主轮边界拉取）+ migrate() 挂载通道
// （恢复时 oldState = 最近快照）+ record-only 效果声明（补偿闭环 = 审计留痕）。

let state = { ticks: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const tools = [
  {
    name: "bump",
    schema: {},
    handler: async (_p, { client }) => {
      await client.declareEffect({
        effectKind: "recover.ticked",
        compensation: { actionRef: "mark", idempotency: "natural" },
      });
      state.ticks += 1;
      return { ...state };
    },
  },
  {
    name: "bump-slow",
    schema: {},
    handler: async (_p, { client }) => {
      await client.declareEffect({
        effectKind: "recover.ticked",
        compensation: { actionRef: "mark", idempotency: "natural" },
      });
      await sleep(500); // 在途窗口：测试在此时 kill Cell 进程（A3 中断点）
      state.ticks += 1;
      return { ...state };
    },
  },
  {
    name: "get-state",
    schema: {},
    handler: async () => ({ ...state }),
  },
];

// 恢复挂载与升级迁移共用通道（契约 §4.5 切片④注记；manifest 稿 §5.5 注记）
export function migrate(oldState) {
  state = oldState ?? { ticks: 0 };
  return { ...state };
}

export function snapshot() {
  return { ...state };
}
