# Phase 5 阶段进度报告：跨 run 会话（续跑 + 崩溃恢复 + 压缩）

- 状态：**定稿**（2026-11-04）
- 日期：2026-11-04
- 关联：[Phase 5 合同](../roadmap/phase-5-session-continuity.md)；[01 会话流](01-session-stream.md) / [02 续跑与恢复](02-resume-and-recovery.md) / [03 压缩](03-compaction.md) / [04 修订清单](04-contract-revision.md)；[ADR-0025](../adr/ADR-0025-session-stream-addressing.md) / [ADR-0026](../adr/ADR-0026-compaction-as-view.md)

## 1. 完成成果（非技术语言）

- **一个会话可以跨多次运行**：`keel run --session <id>` 让后来的运行看见之前的提问、回答与工具结果。证据不是"日志里应该有"——测试里的假模型会把"我看到了几条历史"写进回答，第二次运行从"看见 1 条"变成"看见 2 条"。
- **同一会话一次只跑一个**：被活着的运行占着时，第二个直接拒绝，且**一个字节都不写**（连运行目录都不建）；错误沿用既有码，没有新增。
- **被杀之后能接着干**：进程在"工具已执行、模型还在想"时被强杀，下一次同会话运行会自动先补偿、再校验快照、再开新运行；新运行的历史**只回到最后一个已落盘的一致点**，不会把已被回滚的操作当成事实喂给模型。
- **会话花费不会因重启归零**：已花金额从账本结算记录重算，崩溃时"扣了但没结清"的预扣也按上界计入。
- **上下文可压缩且可还原**：压缩在账本里只是一条"这里压缩过"的事实 + 一次正常计费/计时的摘要调用；模型看到"摘要 + 最近几条"，原始记录一条不少，`sessions show --full` 随时还原未压缩视图。
- **可查看**：`keel sessions list` 看会话与运行数，`keel sessions show` 看模型视图（`--raw` 原始事件、`--full` 还原压缩前）。

## 2. 验收场景逐条结果

| 场景                                      | 结果 | 证据                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **E1【一票否决】跨 run 续跑**（I3/I1）    | ✅   | `tests/session-stream-e2e.test.ts`：第二次运行的模型回答 `seen users=1 tools=1` → `seen users=2 tools=1`；两个独立进程 `sessions show --json` 逐字节一致                                                                                         |
| **E2【一票否决】崩溃恢复接会话**（I2/I3） | ✅   | `tests/session-recovery-e2e.test.ts`：强杀（工具已写、模型挂住）→ 自动恢复 → `RUN_RECOVERED{recoveredFromSeq>0}` → 历史含一致点前的事件 → 另一会话照常 halted                                                                                    |
| **E3【一票否决】压缩不改事实**（I3/I1）   | ✅   | `tests/session-compaction-e2e.test.ts` + `packages/core/test/surface-project-compacted.test.ts`：`SURFACE_COMPACTED` 先于 `TURN_INPUT`；摘要的 `MODEL_INVOKED`/`MODEL_USAGE` 成对且 `usageRef` 对得上；折叠后旧内容消失、`--full` 还原；原文永留 |
| E4 会话隔离（I5）                         | ✅   | `session-stream-e2e`：不同会话互不可见；`--agent other` 显式越界被拒（"not found"）                                                                                                                                                              |
| E5 会话预算连续性（I1/I3）                | ✅   | `packages/host/test/session-budget.test.ts`：已结算 actual + 未结算 estimate 投影；新实例回填后 session 限额继续生效；重复回填幂等                                                                                                               |
| E6 顺序与并发（I1）                       | ✅   | `packages/host/test/session-lease.test.ts`（抢占/并发拒绝/过期接管/死 pid 接管/旧句柄不删新租约）+ `session-stream-e2e`（活租约下第二个 run 被拒且零 `run-*` 写入）                                                                              |
| E7 质量与回归                             | ✅   | 六道门禁：lint 0 / format / `pnpm -r run typecheck` / test **72 文件 512 测试** / `scan-native-plugins` clean；Phase 1~4 承载测试零退化（含 engine/model e2e、throughSeq、cell-crash、快照跨主机）                                               |

## 3. 架构接缝核对

- **账本仍是唯一事实**：`RUN_STARTED.sessionRun` 是追加字段（载荷 v2）；信封、run 内 `seq`、`basedOn`/`throughSeq` 口径未改。会话流不物化索引，顺序与终态都从账本派生。
- **写权未扩散**：单活租约在宿主侧（会话目录 `.lease`），Cell 仍无账本写通道；压缩标记与摘要调用都由 Core/宿主发起。
- **投影仍纯**：`projectSession` 只吃事件流（按会话顺序），跨进程重算一致；压缩折叠是两遍纯函数（区间集合 + 摘要落点），`includeCompacted` 只换输入集合，不读外部状态。
- **恢复语义**：沿用 `RecoveryManager` 的硬顺序（补偿 → 快照 → 新 run）；历史截到一致点；engine 无状态，不挂快照 blob（对话来自账本），快照仍校验存在性。
- **错误码零新增**：并发复用 `SCHED/BACKPRESSURE`；恢复失败沿用 `RECOVER/*`；非法游标 `LEDGER/CURSOR-INVALID`。
- **压缩治理**：摘要调用走既有网关（授权/预扣/结算/`MODEL_*`），失败不阻断任务（无标记、视图不变）。

## 4. 体量核对（standards/08）

- docs 79 篇（软上限 150）；ADR-0025/0026 各 72/74 行（≤100）；设计稿 84~163 行（≤500）；报告本篇 <300 行。
- 新增源码文件均 ≤ 600 行（`session.ts` 195、`lease.ts` 159、`compact.ts` 166、`cmd-sessions.ts` ~170、`cmd-run.ts` ~360）。
- `.agents` 34 个文件（上限 40，不含 vendored）；`CONTEXT.md` ≤150 行。
- 构建产物：按 `pnpm clean` 后复跑（本地无 bash，未见超限告警）。

## 5. 规范复查（standards/09 四问）

- **有漏洞吗**：发现 1 处真实设计缺口——`loadProfile` 在装载期固化插件 scope，运行期覆盖 `plan.scope` 会半覆盖（P-024，已修 + 沉淀）。另发现既有 docs 相对链接基准错误（P-023，登记待修）。
- **过严吗**：单活租约对"同会话并发"零容忍，但跨会话并发不受影响；未见误伤（E6 的两条路径都覆盖）。
- **过松吗**：压缩的"失败不阻断"是有意的（无标记 = 视图不变），由测试钉住；`--full` 与 `--raw` 两条还原/审计路径都有断言。
- **冗余或矛盾吗**：`surfaceOp` 保持预留给 `redact`，压缩用新事件（ADR-0026）——两件事不混用；03 稿的"标记位置"落成"摘要放在被遮蔽区间起点"（实现注记已补），与"摘要 + 最近几条"一致。

## 6. 已知问题与风险

- **根 `tests/` 类型检查缺口**（既有）：试过 `tests/tsconfig.json`（paths 指向各包 src），暴露大量既有错误（归档 cordis 测试为主），已撤回并登记 backlog——需要单独一票，不在本阶段硬塞。
- **压缩触发只做手动 + 阈值**：换模型/overflow 恢复/压力触发留 backlog；阈值取最近一次 `MODEL_USAGE` 输入桶，默认 128000（产品保守值，不是厂商上限）。
- **KV cache 前缀断裂（一次性）**：压缩后首轮从缓存前缀断开；按 deepseek-flash 价目表（research/02 §7）估算，压缩后约 2.5k 全价输入（≈ $0.000375）与压缩前 128k 全命中输入（≈ $0.000384）成本相当，之后每轮约为原来的 1/50；额外成本主要是摘要调用（几百输出 token）。未新增 bench 段。
- **租约无心跳**：TTL 60s 覆盖单次 CLI run；长于 60s 的运行理论上可被接管（单机 MVP 口径），登记为已知上限。
- **恢复不挂引擎快照**：engine 无状态，对话来自账本；能力舱状态各自持久化，不共享 engine 快照 blob。

## 7. 对下阶段的影响

- 会话现在是**一等事实**：`kind:"ui"`/桌面壳可直接消费 `sessions show` 的模型视图与 `--raw` 事件流；多 Agent 编排可在"会话 → run 序列"之上定义委派。
- 压缩的视图操作形状（标记 + 折叠 + 还原）可复用于 UI 的 transcript 折叠。
- 后续候选：fork/回滚、留存 GC、自动压缩调度、会话导出、`kind:"ui"`、多 Agent——全部走 backlog，立项先写 ADR。
- `phase-5.end` tag 与 `docs/phase5-charter` merge 时机归所有者（合并在本轮已按"干完再合并"执行，tag 未打）。

## 8. 文档更新清单

- 新增：本报告；`docs/design/phase-5/01~04`、`ADR-0025`/`ADR-0026`（切片①已登记）；实现期新增测试与夹具（`tests/session-*.test.ts`、`tests/fixtures/profile/session-e2e/`）。
- 修订：01~04 的实施注记、合同 §3/§8、看板 Phase 5 行、CHANGELOG（0.1.061~0.1.065）、`docs/README`、`.agents/CONTEXT.md`、handoff H-038、pitfalls P-023/P-024、skills S-002。
