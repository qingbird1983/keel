# P-001 Windows 子进程 exit 事件滞后于 stdout 关闭

- 环境：win32（本仓开发机）；node child_process spawn
- 症状：子进程死亡后，宿主侧 `stdout` 流先结束（帧通道关闭可立刻感知），`child.on("exit")` 事件晚数十毫秒才触发
- 实测后果（切片③ A2 集成测试）：Supervisor 等 exit 事件做崩溃分类 → run 在 abort 落地前已正常跑完（RUN_HALTED{completed}），原因码丢失

## 规则

1. **进程死亡检测的第一信号 = I/O 流关闭**（stdout end / 通道关闭），exit 事件只用于补充分类信息（退出码）。
2. 分类必须在流关闭时刻即可成立：受控 kill 用**主动标记**（killRequested）判定 killed，不依赖退出码猜测；非受控死亡（流关闭 + 未主动 kill）按 crash 语义先行，exit 事件到位后仅补记录（账本 append-only 不改写，provisional 分类是终局）。
3. 凡"等事件 A 到位再做 B"的时序假设，先实测事件序——跨平台事件序不保证，测试要断言的是**最终账本事实**（RUN_FAILED + 原因码），不是事件回调顺序。

## 关联

- H-012（切片③ Supervisor 实现）；ADR-0005（退出三分类）；契约 §4.1 注记④
