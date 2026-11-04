# H-038 Phase 5 全程收口（立项 → 四切片 → 阶段报告）

- 日期：2026-11-04
- 主题：Phase 5（跨 run 会话：续跑 + 崩溃恢复 + 压缩）——合同定稿、四份设计稿、两篇 ADR、四切片实现与 E1~E7 验收，阶段完成

## 本轮做了什么

1. **立项与合同**：按所有者选择的方向起草 `docs/roadmap/phase-5-session-continuity.md`；§0 现状核对 F1~F8（会话只是信封字段、跨 run 读取为零、恢复无历史、会话预算在内存、压缩只有预留形状）；范围 = 会话流 + 跨 run 投影 + 续跑/恢复 + 会话预算连续性 + 压缩首版；验收 E1~E7（E1/E2/E3 一票否决）；不做 fork/回滚、留存删除、自动压缩调度、UI、多 Agent、会话导出。所有者确认 K1~K6，合同定稿。
2. **切片①设计稿**（`docs/design/phase-5/`）：01 会话流（`sessionRun` 排序、复合游标、单活租约、会话预算投影、投影 v2、CLI）、02 续跑与恢复（有终态=续跑、无终态=恢复且截到一致点、装配顺序、engine 驱动接历史）、03 压缩（`SURFACE_COMPACTED` 载荷、两遍投影折叠、消息组边界、首轮前触发与摘要治理）、04 修订清单（R1~R9 / C1~C5 / T1~T8）。
3. **两篇 ADR**：ADR-0025 会话定址（复合键 vs 扁平 seq，选 A）、ADR-0026 压缩形状（复用 `surfaceOp` vs 新增事件，选新增 `SURFACE_COMPACTED`）。两案对比、建议、被否理由、重评条件齐全。
4. **设计期修正合同**：独立的 `keel compact` 并入 `keel run --compact`——账本拒绝向已终结 run 追加（`ledger.ts:279-286`），独立命令无处落标记。
5. **看板/文档地图/CHANGELOG/backlog/风险登记**：Phase 5 行、6 篇新文档登记、0.1.061~0.1.064、4 条 backlog（fork/回滚、留存 GC、自动压缩、会话导出）、2 条跨阶段风险（并发顺序、摘要变事实）。
6. **切片②实现（会话流端到端）**：
   - Core：`RUN_STARTED{sessionRun}`（载荷 v2）+ `ledger.readRunMeta/listRuns/listAgents/listSessions` + `SessionReader`（有序拼接、复合游标、summary）+ `projectSession`（版本 2）+ `Budgeter.seedSessionUsage`。
   - Host：`SessionLease`（`O_EXCL` + TTL + pid 存活，冲突 `SCHED/BACKPRESSURE`）、`projectSessionBudget`（已结算 actual + 未结算 estimate）、`EngineDriver` 注入会话历史、`loadProfile({sessionId})`。
   - CLI：`run --session`（续跑/新会话；未完成 run 明确提示走 recover）、`sessions list|show [--raw|--json]`；单件路径同样支持 `--session`。
   - 夹具：`tests/fixtures/profile/session-e2e/`（模型把"看到几条历史"写进回答）+ `modules/session-model.mjs` / `session-engine.json`。
   - 测试：会话读取 6、投影 4、租约 4、会话预算 3、真进程端到端 4（E1/E4/E6 + list）。
7. **切片③（崩溃后的会话恢复）**：`prepareSession` 把"最后一个 run 无终态"判成恢复；`RecoveryManager` 的硬顺序（补偿 → 快照校验 → 新 run）之上接会话历史，历史**截到最后一个 `CHECKPOINT.seq`**；`RUN_RECOVERED{recoveredFromSeq}`；engine 无状态不挂快照 blob；R9：Core 生成的 `toolCallId` 带 `runId` 前缀。
8. **切片④（压缩）**：`SURFACE_COMPACTED`（白名单四类）+ `compactSession`（摘要走网关；失败不阻断）+ `projectSession(events,{includeCompacted})` 两遍折叠（摘要落在被遮蔽区间起点、最新摘要为准、消息组不拆）；`BeforeFirstRound` 缝（R8）+ `--compact`/`--compact-threshold`（默认 128000）/`--keep-recent`/`--summary-model`；`sessions show --full` 还原口径。
9. **阶段收口**：`docs/design/phase-5/report.md`（E1~E7 逐条 + 接缝核对 + 体量 + 规范四问）；看板 Phase 5 转 ✅；分支按"干完再合并"并入 main、推送；CI（Node 22/26）绿后打 `phase-5.end` 并推标签。

## 验证

- 六道门禁：`pnpm lint` 0 error；`pnpm format:check` 通过；`pnpm -r run typecheck` 通过；`pnpm test` **72 文件 512 测试**全绿；`node scripts/scan-native-plugins.mjs` clean；新源码文件均 <600 行。
- E1：同一会话第二次 run 的模型回答从 `seen users=1 tools=1` 变成 `seen users=2 tools=1`；两个独立进程的 `sessions show --json` 逐字节一致。
- E2：真进程"工具已写、模型挂住"时强杀 → 自动恢复 → `RUN_RECOVERED{recoveredFromSeq>0}` → 一致点前历史在视图里 → 另一会话照常 halted。
- E3：`SURFACE_COMPACTED` 先于 `TURN_INPUT`；摘要 `MODEL_INVOKED`/`MODEL_USAGE` 成对且 `usageRef` 对得上；折叠后旧内容消失、`--full` 还原、原文永留。
- E5/E6：预算投影单测 3、租约单测 4；预置活租约后第二个 run 被拒且零 `run-*` 写入。
- 文档链接按文件位置写（`../../adr/...`）；新文档体量在预算内。

## 遗留与下一步

- **下一阶段方向待所有者定**；`phase-5.end` 已打并推送（指向 CI 绿的合并提交 `a6a12b4`）。
- 后续候选（backlog）：`kind:"ui"`/桌面壳、多 Agent、fork/回滚、留存 GC、自动压缩调度、会话导出。
- 根 `tests/` 类型检查缺口：试过 `tests/tsconfig.json`（paths 指向各包 src），暴露大量**既有**错误（归档 cordis 测试的导入/隐式 any、engine-kind-e2e 一处强转）；已撤回并登记 backlog，需单独一票。
- 既有 docs 相对链接债（P-023）未修；租约无心跳（>60s 运行可被接管）是单机已知上限。

## 已提取的沉淀

- P-023：设计稿里的相对链接按 docs 根写会指到不存在的路径。
- P-024：profile 的插件 scope 在装载期固化，装配后改 `plan.scope` 不生效（必须走 `loadProfile` 选项）。
- S-002：两案对比的拍板问法（问方案名，不重复 ADR 字母）。
