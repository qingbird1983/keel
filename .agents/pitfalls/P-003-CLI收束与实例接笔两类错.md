# P-003 CLI 收束与实例接笔：spawn 源遗漏与冷实例 runId 复用

- 环境：切片⑤ apps/keel CLI（真实进程 + 多 Ledger 实例）
- 症状：①`keel scenario a5` / `keel hotswap` 逻辑全部 PASS 却**进程挂起不退出**——AssemblyManager 经工厂 spawn 的 Cell 不经过 wireRun 的 bindings 表，closeRuntime 收束不到，子进程 stdio 吊住事件循环；②`keel bench` 报 `LEDGER/WRITE-FAILED "run ledger already exists in another writer session"`——四段基准复用同一 runId，跨 Ledger 实例向既有 run 接笔触发追加序保护

## 规则

1. **资源收束路径必须覆盖所有 spawn 源**：凡绕过主接线原语（wireRun/bindings）创建的子进程/句柄，要么登记进收束表，要么由创建点自己负责 dispose——"主路径有 finally"不等于"全部路径有 finally"。进程挂起的第一排查：数一数 spawn 调用点 vs 收束调用点是否对得上。
2. **冷 Ledger 实例的追加序保护按 runId 计**（`packages/core/src/ledger.ts`："冷实例不允许向已存在账本的 run 接笔"）——同 rootDir 开多个 Ledger 实例时，各实例必须用不相交的 runId 集合；bench/多阶段脚本尤其注意。
3. **依赖材料先于组件构造**（P-002 规则 2 的组件级变体）：`buildRuntime` 的 actionSpec（补偿 Cell 工厂材料）若在构造后才补，执行器带着 null factory 静默运行，非 record-only 效果一派发即抛——表象（补偿失败）远离病灶（构造时缺料）。

## 关联

- H-014（切片⑤ CLI）；apps/keel/src/cmd-hotswap.ts、cmd-bench.ts、cmd-scenario.ts；pitfalls/P-002
