# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**Phase 5 完成——跨 run 会话（续跑 + 崩溃恢复 + 压缩），E1~E7 全过**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（提前收口）/ Phase 3 ✅ / Phase 4 ✅（`phase-4.end` 已打并 merge）
- **Phase 5 ✅ 完成**（2026-11-04，四切片全收）：E1~E7 全过（E1/E2/E3 三条一票否决）；分支已并入 `main` 并推送；**`phase-5.end` 已在 CI 绿后打标（指向 `a6a12b4`）**
  - 合同：[phase-5-session-continuity.md](../docs/roadmap/phase-5-session-continuity.md)
  - 设计稿：[01 会话流](../docs/design/phase-5/01-session-stream.md) / [02 续跑与恢复](../docs/design/phase-5/02-resume-and-recovery.md) / [03 压缩](../docs/design/phase-5/03-compaction.md) / [04 修订清单](../docs/design/phase-5/04-contract-revision.md)（均含实施注记）
  - ADR：[0025 定址](../docs/adr/ADR-0025-session-stream-addressing.md)（选 A 复合键）/ [0026 压缩](../docs/adr/ADR-0026-compaction-as-view.md)（选新增 `SURFACE_COMPACTED`）
  - 报告：[design/phase-5/report.md](../docs/design/phase-5/report.md)

## 本轮关键结论（别丢）

- **会话 = `(agentId, sessionId)` 下按 `sessionRun` 排序的 run 序列**；事件地址保持 `(runId, seq)`（ADR-0025）。`RUN_STARTED` 载荷 v2 带 `sessionRun`；旧账本按 `startedAt`+`runId` 排在编号 run 前。
- **读取**：`SessionReader`（core）跨 run 拼接 + 复合游标；`SessionEvent.runOrdinal` 是会话流位置；不物化索引。
- **单活**：`SessionLease`（`.lease` + `O_EXCL` + TTL 60s + 同机 pid），冲突 `SCHED/BACKPRESSURE`、**零写入**；**无心跳**（>60s 的运行理论可被接管，单机已知上限）。
- **续跑 / 恢复**：有终态 = 续跑（全量会话投影）；无终态 = 自动恢复（补偿 → 快照校验 → 新 run），历史**截到最后一个一致点**，写 `RUN_RECOVERED{recoveredFromSeq}`；`--input` 缺省 `"continue"`。恢复不挂引擎快照 blob（engine 无状态，03 稿 E7）。
- **预算**：`projectSessionBudget` = Σ settled.actual + Σ 未结算 estimate；`Budgeter.seedSessionUsage` 首绑幂等回填。
- **压缩**：`SURFACE_COMPACTED`（白名单四类）承载"视图怎么折叠"，摘要走网关（`MODEL_*` 成对），原文永留；`projectSession(events,{includeCompacted})` 两遍折叠；**摘要落在被遮蔽区间起点**（摘要 + 最近几条）；切点按消息组（调用 + 结果不拆）；`--compact`/`--compact-threshold`（默认 128000）/`--keep-recent`；失败 = 无标记、任务继续。
- **CLI**：`run --session`、`sessions list|show [--raw|--full|--json]`；`--full` = 还原压缩前视图。
- **profile 覆盖走装载期**：`loadProfile({sessionId})`（P-024）。

## 已验证 / 未验证

- 六道门禁全绿：lint 0 / format / `pnpm -r run typecheck` / test **72 文件 512 测试** / 扫描 clean；新源码 <600 行。
- E1：第二次 run 的模型回答 `seen users=1 tools=1` → `seen users=2 tools=1`；两进程视图逐字节一致。
- E2：真进程强杀 → 自动恢复 → `RUN_RECOVERED{recoveredFromSeq>0}` → 一致点前历史在视图里 → 另一会话照常 halted。
- E3：`SURFACE_COMPACTED` 先于 `TURN_INPUT`；摘要 `MODEL_INVOKED`/`MODEL_USAGE` 成对且 `usageRef` 对得上；折叠后旧内容消失、`--full` 还原、原文永留。
- **未验证**：真实模型（`model-deepseek` 仍手动、不进 CI）；跨机租约（单机 MVP）。
- **工具债**：根 `tests/` 类型检查覆盖仍是缺口（试过一版，暴露归档 cordis 测试的既有错误；已撤回并登记 backlog）。

## 下一步（按优先级）

1. 下一阶段方向待所有者定（均走 backlog/ADR）：`kind:"ui"`/桌面壳、多 Agent 编排、会话 fork/回滚、留存 GC、自动压缩调度、会话导出、压缩的缓存友好化。
2. 若先不动方向：可清既有欠账——根 `tests/` 类型检查（单独一票）、phase-1~4 设计稿相对链接（P-023）。

## 关键提醒（坑/规范/易错点）

- **profile scope 装载期固化**：[P-024](pitfalls/P-024-profile-scope在装载期固化.md)——运行期覆盖只能走 `loadProfile` options
- **设计稿链接别照抄旧稿**：[P-023](pitfalls/P-023-设计稿相对链接按docs根写会断.md)——`docs/design/phase-N/` 用 `../../adr/`
- **拍板问法**：[S-002](skills/S-002-两案对比的拍板问法.md)——问方案名、不重复 ADR 字母
- **装配记录不止一条**：[P-022](pitfalls/P-022-装配记录逐插件化后补偿只读第一条.md)
- **注册表先定作用域**：[P-020](pitfalls/P-020-模型按名注册把跨装配重绑当成重复.md)
- **金额累加要收浮点尾**：[P-021](pitfalls/P-021-金额浮点求和噪声让预算断言飘.md)
- **数值哨兵不要用 falsy**：[P-019](pitfalls/P-019-把0当缺省值导致空resources插件装载即崩.md)
- **Schema 只能用关键词子集**：[P-014](pitfalls/P-014-自研Schema子集把动态键映射当成已支持.md)
- **改文本只用 edit/write 工具**：[P-017](pitfalls/P-017-powershell改写破坏编码.md)；Windows 控制台乱码 ≠ 文件坏了（用 read 核对）
- **外部事实带来源与检索日期**：[P-018](pitfalls/P-018-外部API事实过期.md)；`deepseek-chat`/`deepseek-reasoner` 已停用
- **ADR 只增不改**；docs 新增必须登记 `docs/README.md`；CHANGELOG 新在前（本轮 0.1.065）
- **体量**：docs 80 篇（软上限 150）；`.agents` 34 个文件（上限 40，不含 vendored）；CONTEXT ≤150 行
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-024）；方法索引：[skills/](skills/README.md)（S-001~S-002）
