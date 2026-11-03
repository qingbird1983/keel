// 切片⑤ B7② fixture：有状态插件 + **自我崩溃**（tests/snapshot-cross-host.test.ts 用）。
//
// 为什么要自我崩溃而不是"测试杀宿主"：崩溃让宿主自己把 run 收在 RUN_FAILED 并正常退出，
// 于是账本里已经落下 rounds-1 轮的 CHECKPOINT + STATE_SNAPSHOT_REF，而宿主 A 进程已经结束——
// 下一个 `keel recover` 是**真正的另一个宿主进程**（跨宿主重启），不需要在测试里制造进程死亡时序。
//
// 崩溃点：第 CRASH_AT 次 tick 在途时抛未捕获异常（与 boom-plugin.mjs 同一形状：handler 保持在途，
// 保证崩溃落在工具请求在途窗口内，落点是确定性的）。前面的轮次正常返回并留下快照。

let state = { ticks: 0 };

/** 第 3 次调用崩溃：于是 ticks=1 与 ticks=2 各收过一次尾（两个一致点 + 两个快照引用）。 */
const CRASH_AT = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const tools = [
  {
    name: "tick",
    schema: {},
    handler: async () => {
      state.ticks += 1;
      if (state.ticks >= CRASH_AT) {
        setTimeout(() => {
          throw new Error(`stateful-boom: uncaught plugin failure at tick ${String(state.ticks)}`);
        }, 10);
        await sleep(300); // 保持在途，让崩溃发生在请求窗口内（宿主侧按 CELL/CRASH 收）
      }
      return { ...state };
    },
  },
  {
    name: "get-state",
    schema: {},
    handler: async () => ({ ...state }),
  },
];

// 恢复挂载与升级迁移共用通道（契约 §4.5 切片④注记）：oldState = 宿主给回的最近快照
export function migrate(oldState) {
  state = oldState ?? { ticks: 0 };
  return { ...state };
}

export function snapshot() {
  return { ...state };
}
