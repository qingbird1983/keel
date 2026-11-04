# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**Phase 5 立项 + 切片①设计定稿 + 切片②会话流端到端**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（提前收口）/ Phase 3 ✅ / Phase 4 ✅（`phase-4.end` 已打并 merge）
- **Phase 5 进行中，切片① ✅ / 切片② ✅**（分支 `docs/phase5-charter`，5 次提交，**未合并**）
  - 合同：[phase-5-session-continuity.md](../docs/roadmap/phase-5-session-continuity.md)（K1~K6 + 第二道闸 K2/K4 已确认）
  - 设计稿：[01 会话流](../docs/design/phase-5/01-session-stream.md) / [02 续跑与恢复](../docs/design/phase-5/02-resume-and-recovery.md) / [03 压缩](../docs/design/phase-5/03-compaction.md) / [04 修订清单](../docs/design/phase-5/04-contract-revision.md)（含实施注记）
  - ADR：[0025 定址](../docs/adr/ADR-0025-session-stream-addressing.md)（选 A 复合键）/ [0026 压缩](../docs/adr/ADR-0026-compaction-as-view.md)（选新增 `SURFACE_COMPACTED`）
- 验收进度：E1（跨 run 续跑）/ E4（隔离）/ E5（会话预算连续性，单测层）/ E6（单活）已有证据；E2（崩溃恢复）、E3（压缩）待切片③/④

## 本轮关键结论（别丢）

- **会话 = `(agentId, sessionId)` 下按 `sessionRun` 排序的 run 序列**；事件地址保持 `(runId, seq)`；`RUN_STARTED` 载荷 v2 带 `sessionRun`（ADR-0025 选 A）。
- **读取面**：`SessionReader`（core）跨 run 有序拼接 + 不透明复合游标 `{i,s}`；不物化索引，顺序从 `readRunMeta` 派生（旧账本按 `startedAt`+`runId` 排在编号 run 之前）。`SessionEvent.runOrdinal` 是**会话流位置**，不一定是 `sessionRun`。
- **单活**：`SessionLease`（host）`.lease` + `O_EXCL` + TTL(60s) + 同机 pid 存活；冲突 `SCHED/BACKPRESSURE`、**零写入**、错误码零新增。获取在任何写/装配之前。
- **续跑**：`keel run --profile P --session S`；历史 = `projectSession(全量会话事件)`，经 `EngineDriver({history})` 注入（engine 仍不读账本、不跨 run）；`TURN_INPUT` 仍只写本次输入。
- **崩溃未接**：最后一个 run 无终态时，切片②明确拒绝并提示 `keel recover`（自动恢复 = 切片③）。恢复口径：历史**截到最后一个 `CHECKPOINT.seq`**（一致点之后的效果会被补偿回滚）。
- **会话预算**：`projectSessionBudget` = Σ`BUDGET_SETTLED.actual` + Σ 未结算 `BUDGET_RESERVED.estimate`；`Budgeter.seedSessionUsage` 在会话绑定后首次幂等回填，运行期仍用内存态。
- **profile 覆盖走装载期**：`loadProfile({sessionId})`——插件 scope 在装载期固化，装配后改 `plan.scope` 不生效（P-024）。
- **压缩（未做）**：新增 `SURFACE_COMPACTED`（白名单三类 → 四类）、摘要走网关、原文永留、`includeCompacted` 还原；命令并入 `keel run --compact`（不提供独立 `keel compact`）。

## 已验证 / 未验证

- 六道门禁全绿：lint 0 / format / `pnpm -r run typecheck` / test **69 文件 506 测试** / 扫描 clean；新源码 <600 行。
- E1 真进程证据：同会话第二次 run 的模型回答 `seen users=1 tools=1` → `seen users=2 tools=1`；两个独立进程 `sessions show --json` 逐字节一致。
- E6：预置活租约 → 第二个 run 被拒（"session is busy"），目标会话目录零 `run-*`。
- **未验证**：E2 崩溃恢复、E3 压缩、`--compact`/阈值、`includeCompacted`；R8/R9 未做。
- **工具债未清**：根 `tests/` 类型检查覆盖试过一版，暴露既有错误（归档 cordis 测试为主），已撤回并登记 backlog，不把红门禁留主线。

## 下一步（按优先级）

1. **切片③（下一步）**：崩溃后的会话恢复。复用 `RecoveryManager`（补偿 → 快照挂载 → 新 run），历史截到一致点；自动判定"有终态=续跑 / 无终态=恢复"；engine 驱动接恢复；R8（`beforeFirstRound` 缝）/ R9（toolCallId 前缀）同片。
2. 切片④：压缩——`SURFACE_COMPACTED`（R5）、摘要受治理调用、投影折叠 + `includeCompacted`、`keel run --compact` + 阈值。
3. 收尾：E1~E7 复核 + 报告；`docs/phase5-charter` merge 与 `phase-5.end` 时机归所有者。

## 关键提醒（坑/规范/易错点）

- **profile scope 装载期固化**：[P-024](pitfalls/P-024-profile-scope在装载期固化.md)——运行期覆盖只能走 `loadProfile` options，装配后改 `plan.scope` 是静默半覆盖
- **设计稿链接别照抄旧稿**：[P-023](pitfalls/P-023-设计稿相对链接按docs根写会断.md)——`docs/design/phase-N/` 用 `../../adr/`
- **拍板问法**：[S-002](skills/S-002-两案对比的拍板问法.md)——问方案名、不重复 ADR 字母
- **装配记录不止一条**：[P-022](pitfalls/P-022-装配记录逐插件化后补偿只读第一条.md)
- **注册表先定作用域**：[P-020](pitfalls/P-020-模型按名注册把跨装配重绑当成重复.md)
- **金额累加要收浮点尾**：[P-021](pitfalls/P-021-金额浮点求和噪声让预算断言飘.md)
- **数值哨兵不要用 falsy**：[P-019](pitfalls/P-019-把0当缺省值导致空resources插件装载即崩.md)
- **Schema 只能用关键词子集**：[P-014](pitfalls/P-014-自研Schema子集把动态键映射当成已支持.md)
- **改文本只用 edit/write 工具**：[P-017](pitfalls/P-017-powershell改写破坏编码.md)；Windows 控制台乱码 ≠ 文件坏了（用 read 核对）
- **外部事实带来源与检索日期**：[P-018](pitfalls/P-018-外部API事实过期.md)；`deepseek-chat`/`deepseek-reasoner` 已停用
- **ADR 只增不改**；docs 新增必须登记 `docs/README.md`；CHANGELOG 新在前（本轮 0.1.064）
- **体量**：docs 79 篇（软上限 150）；`.agents` 34 个文件（上限 40，不含 vendored）；CONTEXT ≤150 行
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-024）；方法索引：[skills/](skills/README.md)（S-001~S-002）
