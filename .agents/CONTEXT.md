# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**Phase 5 立项——合同定稿、切片①四稿 + ADR-0025/0026，两次闸全过**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（提前收口）/ Phase 3 ✅ / Phase 4 ✅（`phase-4.end` 已打并 merge）
- **Phase 5 已开工，切片① ✅ 完成**（分支 `docs/phase5-charter`，4 次提交，**未合并**）：
  - 合同定稿：[phase-5-session-continuity.md](../docs/roadmap/phase-5-session-continuity.md)（K1~K6 已确认）
  - 四份设计稿：[01 会话流](../docs/design/phase-5/01-session-stream.md) / [02 续跑与恢复](../docs/design/phase-5/02-resume-and-recovery.md) / [03 压缩](../docs/design/phase-5/03-compaction.md) / [04 修订清单](../docs/design/phase-5/04-contract-revision.md)
  - 两篇 ADR 定稿：[0025 定址](../docs/adr/ADR-0025-session-stream-addressing.md)（选 A 复合键）/ [0026 压缩](../docs/adr/ADR-0026-compaction-as-view.md)（选新增 `SURFACE_COMPACTED`）
- Phase 5 范围：会话流 + 跨 run 投影 + 续跑/崩溃恢复 + 会话预算连续性 + 压缩首版；验收 E1~E7（E1/E2/E3 一票否决）

## 本轮关键结论（别丢）

- **会话 = `(agentId, sessionId)` 下按 `sessionRun` 排序的 run 序列**；事件地址保持 `(runId, seq)`（ADR-0025 选 A），信封与 `basedOn`/`throughSeq` 的 run 内口径不动。`sessionRun` 落 `RUN_STARTED` 追加字段（载荷 v2）。
- **同会话单活**：租约文件 `.lease`（`O_EXCL` + TTL + pid 存活），冲突复用 `SCHED/BACKPRESSURE`、**拒绝路径零写入**、错误码零新增。
- **续跑 vs 恢复**：前一个 run 有终态 = 续跑（历史 = 全量会话投影）；无终态 = 恢复（补偿 → 快照 → 新 run），历史**截到该 run 最后一个 `CHECKPOINT.seq`**——一致点之后的效果会被补偿回滚，给模型看会造成"视图与副作用不一致"。
- **压缩是视图操作**：新增表面事件 `SURFACE_COMPACTED`（白名单三类 → 四类），摘要调用走既有网关（`MODEL_*` 成对、预算/超时/失败），原始事件永留，`includeCompacted` 可还原。`surfaceOp` 保持预留给 `redact`。
- **压缩命令并入下一次 run**：`keel run --compact`（不提供独立 `keel compact`——账本拒绝向已终结 run 追加）；阈值取最近一次 `MODEL_USAGE` 输入桶，默认 128000。
- **会话预算**：`used = Σ BUDGET_SETTLED.actual + Σ 未结算 reservation.estimate`；会话绑定时一次性投影并 seed 给 `Budgeter`，运行期仍用内存态。
- **投影 v2**：`projectSession` 跨 run 拼接；`toolCallId` 由 Core 生成时带 `runId` 短前缀，避免跨 run 撞号。

## 已验证 / 未验证

- 已验证（本轮）：`prettier --check docs CHANGELOG.md` 全通过；新文档体量在预算内（ADR 72/74 行、设计稿 84~159 行、合同 125 行）；两次闸的所有者确认已回填合同 §8 / 两份 ADR / docs/README。
- **未验证**：本轮**零代码改动**，代码门禁（lint/typecheck/build/test/扫描）未跑也无需跑（铁律 1）。
- 既有欠账未变：根 `tests/` 不在任何包 tsconfig include 内（类型检查缺口）。

## 下一步（按优先级）

1. **切片②（下一步）**：会话流端到端。按 [04 稿](../docs/design/phase-5/04-contract-revision.md) 实施顺序：R1/R2/R7 + T5/T7 → R3/R4/R6 + T1/T2；红测先行。核心落点：`core/ledger.readRunMeta`、`core/session.ts`、`surface.projectSession`（v2）、`budget.seedSessionUsage`、`host/session/`（Store + Lease）、CLI `--session` / `sessions`。
2. 切片③：崩溃后的会话恢复（`RecoveryManager` + 一致点截断 + engine 驱动接历史）；切片④：压缩（R5/R8/R9 + T3/T4/T8）。
3. 工具债：切片①/② 顺手清根 `tests/` 的 tsconfig 覆盖。
4. 所有者决定：`docs/phase5-charter` merge 时机；`phase-5.end` 时机。

## 关键提醒（坑/规范/易错点）

- **设计稿链接别照抄旧稿**：[P-023](pitfalls/P-023-设计稿相对链接按docs根写会断.md)——`docs/design/phase-N/` 里要用 `../../adr/`；phase-3/4 的 `../adr/` 是历史债，未修（别跟着抄）
- **拍板问法**：[S-002](skills/S-002-两案对比的拍板问法.md)——问方案名、不重复 ADR 字母；回填时按名字记录
- **装配记录不止一条**：[P-022](pitfalls/P-022-装配记录逐插件化后补偿只读第一条.md)
- **注册表先定作用域**：[P-020](pitfalls/P-020-模型按名注册把跨装配重绑当成重复.md)
- **金额累加要收浮点尾**：[P-021](pitfalls/P-021-金额浮点求和噪声让预算断言飘.md)
- **数值哨兵不要用 falsy**：[P-019](pitfalls/P-019-把0当缺省值导致空resources插件装载即崩.md)
- **Schema 只能用关键词子集**：[P-014](pitfalls/P-014-自研Schema子集把动态键映射当成已支持.md)
- **改文本只用 edit/write 工具**：[P-017](pitfalls/P-017-powershell改写破坏编码.md)；Windows 控制台中文乱码不代表文件坏了（用 read 核对）
- **外部事实带来源与检索日期**：[P-018](pitfalls/P-018-外部API事实过期.md)；`deepseek-chat`/`deepseek-reasoner` 已停用
- **ADR 只增不改**；docs 新增必须登记 `docs/README.md`；CHANGELOG 新在前（本轮 0.1.063）
- **体量**：docs 79 篇（软上限 150）；`.agents` 34 个文件（上限 40，不含 vendored）；CONTEXT ≤150 行
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-023）；方法索引：[skills/](skills/README.md)（S-001~S-002）
