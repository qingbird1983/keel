# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 1 切片④落地——补偿执行器 + 恢复链路 + 快照 + 换页，A3/A4 实现主体）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 🔄 进行中（tag `phase-1.start`）**——切片①②③④ 已落地；施工顺序唯一来源：`docs/roadmap/phase-1-mvp.md`
- 已落地：Core 四件套 + 调度轮循环（切片①②）+ Cell 运行时 + Host 装配（切片③）+ 补偿状态机 T01~T14 / recover.plan-execute / 快照链路 / context 换页（切片④），**191 测试全绿，六道门禁绿，零运行时依赖**
- 验收进度：A2/A3/A4 均真实进程测试化（`tests/` 三份集成，3 次复跑稳定）；A5 在 host 单测；A6 审计重放骨架（事件全留痕）+ 补偿闭环可重放投影
- 切片④顺带修复切片②潜伏缺陷：轮边界 CHECKPOINT 原为普通 append（无 fsync、不置恢复锚）→ 改走 `ledger.checkpoint`（复现测试先行，铁律 7）

## 上一轮完成了什么（3~5 条）

- host 四新模块：CompensationExecutor（账本重放投影 / 逆拓扑分波 + 有界并行 / ≤3 次≤30s 退避 / escalated 阻断 + waive/repair / record-only 直闭 + 告警缝）、RecoveryManager（plan/execute，先补偿后延续）、EffectTracker（结算 + dependsOn 声明期查环）、SnapshotStore（内存持有）
- core/cell-runtime 缝：PendingCompensator 三态签名 + onCheckpoint 快照索取缝 + recoveredFrom/RUN_RECOVERED 首事件 + context 换页原语；`cell.snapshot` / `compensation.exec` 两新 op
- A4 三路径集成（undo 幂等重入 / 升级阻断 / record-only+告警）+ A3 集成（kill → plan 一致点+未决清单 → execute 挂载快照新 runId 延续）
- 设计稿增量：契约 §4.1⑥⑦/§4.5/§4.6/§5+CONTEXT_PAGED；补偿稿 §13 定案六条；manifest 稿插件导出面注记

## 下一步（按优先级，注明阻塞项）

1. **切片⑤**：A8 基准（账本吞吐 / 网关延迟 / Cell 冷启 / 补偿编排延迟）+ fixtures 三组收全（schema 负路径 / 账本回放 / 补偿桩组）+ **apps/keel CLI**（验收复演入口：A2/A3/A4/A5 由 CLI 执行）（阻塞：无）
2. 回填项（基准期）：model.stream 流式通道（契约 §4.7）；policy 插件接 HookBus 装配链；旧 Cell drain 完整语义
3. 远端仓库配置（阻塞：所有者提供地址）

> 实现中发现契约缺陷 → 先改设计文档（带日期注记）再改码；补偿触发三态映射（§4.1 注记⑥）与快照索取缝（SchedulerOptions.onCheckpoint）是既有关键缝。

## 未决问题

- git 远端（所有者）；版权署名占位（LICENSE + 两 README + ADR-0006 四处，所有者决定）
- 快照物理持久化（宿主崩溃恢复）、probe 通道、退避参数可配置面、migration 多步链、未决污染清单 CLI——登记 backlog，基准后回评
- 补偿动作通道进程冷启开销（每批一次）入 A8 基准观测

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **集成测试装配接线三类错**：deps/opts 参数位错置静默失效；模块顶层构造捕获未初始化变量——凡依赖 beforeAll 的组件一律在 hook 内构造 → [P-002](pitfalls/P-002-集成测试装配接线三类错.md)
- **Windows 子进程 exit 事件滞后 stdout 关闭**——死亡第一信号 = 通道关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- 调度器是轮内事件唯一编排者（gateway/cell-server/补偿执行器直写账本均为注记背书的先例）；轮边界 CHECKPOINT 必走 `ledger.checkpoint`（fsync + lastCheckpoint 锚），不可用 append
- 补偿投影以账本为唯一事实源（执行器可随时崩溃重放）；撤销序 = 依赖者先撤（Kahn 入度方向）+ 同层 LIFO
- kill 后在途轮正常收束（一致点推进到收束轮）；快照拉取失败被吞（辅助元数据，A3 按此断言）
- cell 侧不持有 scope/runId（宿主服务端盖章）；seq 是 Run 内单调；恢复/延续一律新 runId
- typescript 锁 ^5.9；tsconfig.base 锁 ES2022（无 Promise.withResolvers，手动 deferred）
- 踩坑索引：[pitfalls/](pitfalls/)（P-001、P-002）
