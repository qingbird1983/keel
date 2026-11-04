# Phase 5 切片①设计稿 04：契约与 CLI 修订清单（含测试与门禁）

- 状态：**定稿**（2026-11-04 起草并定稿：随 ADR-0025 选 A 复合键、ADR-0026 选新增 `SURFACE_COMPACTED` 同步定稿）
- 日期：2026-11-04
- 关联：[01](01-session-stream.md) / [02](02-resume-and-recovery.md) / [03](03-compaction.md)；[ADR-0025](../../adr/ADR-0025-session-stream-addressing.md) / [ADR-0026](../../adr/ADR-0026-compaction-as-view.md)；[契约](../../design/phase-1/01-core-api-contract.md)；`packages/core/src/{ledger,events,surface,scheduler}.ts`；`apps/keel/src/main.ts`

## 1. 这篇清单怎么用

01~03 的决策落到**有校验器/有测试/有账本**的地方才有约束力。本文把每处改动列成可勾选条目：改哪个文件、改什么、依据哪条设计。**没有列出的地方不改**；实施中发现清单外缺口 → 停下写 ADR 或记 backlog（范围纪律）。

## 2. 契约修订（`docs/design/phase-1/01-core-api-contract.md`）

| 编号 | 位置                  | 变更                                                                                                                                                 | 依据                   |
| ---- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| R1   | §5 `RUN_STARTED` 载荷 | 升 v2：追加 `sessionRun:number`（会话内单调整数，宿主分配）。旧账本缺省 → 按 `RUN_STARTED.ts` + `runId` 排序的兼容规则                               | 01 稿 §3.1；ADR-0025   |
| R2   | §4.4 账本读取面       | 新增 **Core 内部**读取面 `ledger.readRunMeta(ref)`：首次 `RUN_STARTED`、最后事件判终态、`lastSeq`。**不进 Cell 通道**，不新增 op                     | 01 稿 §3.2             |
| R3   | §4.4 账本读取面       | 新增会话读取面 `session.read(ref, filter, cursor)`：跨 run 有序拼接、复合游标（不透明）。仅 Host/CLI 使用，Cell 仍只有 run 级 `ledger.read`          | 01 稿 §3.2；ADR-0025   |
| R4   | §5 表面投影           | `SURFACE_PROJECTION_VERSION = 2`；新增 `projectSession(events, {includeCompacted})`。规则集 = 跨 run 拼接 + 压缩折叠；同一输入 + 同一版本 = 同一输出 | 01 稿 §3.5；03 稿 §3   |
| R5   | §5 事件表             | 新增表面事件 `SURFACE_COMPACTED`（载荷见 03 稿 §3）；白名单第三类 → 第四类；`surfaceOp` **保持预留**，不参与压缩                                     | 03 稿 §3；ADR-0026     |
| R6   | §6 错误码             | **零新增**：会话并发复用 `SCHED/BACKPRESSURE`（detail 加 `{session, heldBy}`）；恢复失败沿用 `RECOVER/*`；读取非法游标沿用 `LEDGER/CURSOR-INVALID`   | 01 稿 §3.3；02 稿 §3.4 |
| R7   | §4.3 预算注记         | 会话预算投影口径：`used = Σ BUDGET_SETTLED.actual + Σ 未结算 reservation.estimate`；`Budgeter` 在会话绑定时用投影值初始化，运行期内仍以内存态推进    | 01 稿 §3.4             |
| R8   | §4.1 调度器缝         | `RunManifest.beforeFirstRound?`：`RUN_STARTED`/`ASSEMBLY_*` 之后、`TURN_INPUT` 之前执行一次；压缩只在这里发生（其 `MODEL_*` 事件落本 run）           | 03 稿 §4               |
| R9   | §5 `TOOL_RESULT` 注记 | Core 生成的 `toolCallId` 带 `runId` 短前缀，避免跨 run 撞号导致投影配错（模型给的 id 原样保留）                                                      | 01 稿 §3.5             |

## 3. CLI 修订（`apps/keel/src/main.ts` + `cmd-run.ts` + 新 `cmd-sessions.ts`）

| 编号 | 命令                                                                                   | 变更                                                                                     |
| ---- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| C1   | `keel run ... --session <id>`                                                          | 指定会话；无则新建、有则续跑（02 稿 §3.2）。与 `--profile` / `--manifest` 均可组合       |
| C2   | `keel run ... --compact [--keep-recent N] [--compact-threshold T] [--summary-model M]` | 首轮前强制压缩（或缺省按阈值自动）；`--keep-recent` 默认 6、阈值默认 128000              |
| C3   | `keel sessions list --data-dir D [--agent A]`                                          | 列出会话：run 数、最后状态、最后时间、是否有活跃 run                                     |
| C4   | `keel sessions show --data-dir D --session S [--raw] [--json]`                         | 默认打印模型视图；`--raw` 原始事件流；`--json` 机读                                      |
| C5   | **不新增** `keel compact`                                                              | 账本拒绝重开已终结 run（`ledger.ts:279-286`）；压缩并入下一次 run 的启动阶段（03 稿 §4） |

> 修订说明（2026-11-04）：phase-5 合同 §4/§6 S8 原列 `keel compact` 独立命令，按上表 C5 并入 `run` 的开关；合同已同步注明。

## 4. 代码落点（不动既有事实面）

| 模块                                 | 改动                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `packages/core/src/ledger.ts`        | `readRunMeta`（只读）；不改编排写路径                                    |
| `packages/core/src/session.ts`（新） | `SessionEvent` / 游标编解码 / `readSession`（调用既有 `ledger.read`）    |
| `packages/core/src/surface.ts`       | `projectSession` + 版本升 2；`projectSurface` 保留（run 内旧调用零迁移） |
| `packages/core/src/events.ts`        | `SURFACE_COMPACTED` 入事件表与白名单；载荷类型；`RUN_STARTED` 版本表     |
| `packages/core/src/budget.ts`        | `seedSessionUsage(ref, used)`（幂等：只允许在会话绑定后首次调用）        |
| `packages/core/src/scheduler.ts`     | `beforeFirstRound` 缝（R8）                                              |
| `packages/host/src/session/`（新）   | `SessionStore`（summary/read/lease）、续跑与恢复入口的编排               |
| `packages/host/src/recovery.ts`      | 不改顺序；`cont` 回调由调用方提供历史与 `turnInput`                      |
| `packages/host/src/engine-driver.ts` | 注入 `history`，每步拼接本 run 新增表面事件                              |
| `apps/keel/src/`                     | `--session` / `--compact*` / `sessions` 子命令；`cmd-recover` 带历史     |

## 5. 测试与门禁

| 编号 | 文件（新）                                           | 覆盖                                                            |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------- |
| T1   | `tests/session-stream-e2e.test.ts`                   | E1/E4/E6：三次 run 的视图、两进程重算、越界读取、并发拒绝零写入 |
| T2   | `tests/session-budget-e2e.test.ts`                   | E5：跨进程用量连续、未结算预扣计入、超支夹取                    |
| T3   | `tests/session-recovery-e2e.test.ts`                 | E2：强杀 → 自动恢复 → 一致点截断 → 补偿回放 → 并行会话无影响    |
| T4   | `tests/session-compaction-e2e.test.ts`               | E3：摘要调用成对、折叠、还原、失败无标记、消息组不切开          |
| T5   | `packages/core/test/session-read.test.ts`            | 游标/分页/类型过滤/旧账本排序                                   |
| T6   | `packages/core/test/surface-project-session.test.ts` | 投影确定性与版本绑定（含快照式期望）                            |
| T7   | `packages/host/test/session-lease.test.ts`           | 租约获取/过期接管/同进程重入（注入时钟）                        |
| T8   | `apps/keel/test/cli.test.ts`（追加）                 | `--session` / `sessions` / `--compact` 冒烟与退出码             |

- **红测先行**：T1~T8 的关键断言先写失败用例（standards/05）。
- **禁面扫描**：本阶段**不新增插件 kind**，`scripts/scan-native-plugins.mjs` 的规则集不动；新增的机械约束用测试表达：① 会话读取不跨 `agentId`（T1）；② 摘要请求不含治理字段（T4）；③ 每次模型调用都有网关的 `MODEL_INVOKED`/`MODEL_USAGE` 成对（T4 与既有 D2 断言复用）。
- **工具债**：根 `tests/` 不在任何包 tsconfig include 内——切片① 补一个 `tests/tsconfig.json`（或纳入宿主 include）并让 `pnpm typecheck` 覆盖；否则本阶段新增 e2e 的类型错仍会漏到运行期。

## 6. 不新增 / 不改动（自检）

- [ ] 新增事件类型仅 1 条（`SURFACE_COMPACTED`）、新增 Cell op **0** 条、新增错误码 **0** 条
- [ ] 信封、run 内 `seq`、`basedOn`/`throughSeq` 语义未改
- [ ] `surfaceOp` 仍为预留（若所有者选 A 则本节与 R5 按 ADR-0026 的 A 案改写）
- [ ] manifest / profile schema **无改动**（压缩配置只走 CLI；不进插件报关单）
- [ ] 补偿语义、策略 hook 词表、禁面规则集未动
- [ ] 旧账本（无 `sessionRun`）可读、可投影、可 `sessions show`

## 7. 实施顺序（过闸后）

1. R1/R2/R7 + T5/T7 红测（账本与预算的只读面先行，不改写路径）；
2. R3/R4/R6 + T1/T2（会话流端到端）；
3. R8/R9 + T3（续跑与恢复）；
4. R5 + T4 + T8（压缩与 CLI 收口）；
5. 两篇 ADR 定稿、01~03 回填"实施注记"（只补事实，不改决策）。
