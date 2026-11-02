// V5 fixture：v2 版本有状态插件——迁移钩必抛（热装配回退路径的注入点）。
// 形状与 recover-plugin 同构（snapshot/state 工具），仅 migrate 语义不同：
// A5 主张 = 迁移钩失败 → 新 Cell 丢弃、旧作用域原样（回退）。

let state = { ticks: 0, v2: true };

export const tools = [
  {
    name: "get-state",
    schema: {},
    handler: async () => ({ ...state }),
  },
];

export function migrate(_oldState) {
  throw new Error("migration hook exploded (V5 rollback fixture)");
}

export function snapshot() {
  return { ...state };
}
