# Phase 5 切片①设计稿 02：续跑与崩溃恢复（统一入口与一致点语义）

- 状态：**定稿**（2026-11-04 起草并定稿：所有者第二道闸拍板 K2 选 A 复合键）
- 日期：2026-11-04
- 关联：[phase-5 合同](../../roadmap/phase-5-session-continuity.md) §2/§5 E2/§6 S5；[01 稿](01-session-stream.md)（会话流与单活）；[ADR-0004](../../adr/ADR-0004-ledger-consistency-point.md)（一致点、轮边界 fsync）；[ADR-0021](../../adr/ADR-0021-session-ledger-topology.md)（统一流）；[契约 §4.5](../../design/phase-1/01-core-api-contract.md)（恢复语义）；`packages/host/src/recovery.ts`（既有恢复器）

## 1. 目标与边界

回答一件事：**同一个会话的下一次 run 从哪里开始，凭什么敢说"接着干"。**

两个入口、一套落地：

- **续跑（resume）**：前一个 run 有终态（`halted` / `failed`）。不需要补偿（终态流程已收束），历史 = 会话投影。
- **恢复（recover）**：前一个 run 无终态（进程被杀、宿主崩溃）。先按既有顺序补偿 → 挂快照 → 新 run 接续，历史 = **到最后一个一致点为止**的会话投影。

两条路的产物相同：新 `runId` + 新 `sessionRun` + 会话历史 + 本次 `TURN_INPUT`。

## 2. 事实核对（带证据）

- **F1 恢复器已有完整顺序**：`plan`（一致点 / 未决效果 / 最近快照）→ `execute`（全 run 补偿 → 快照挂载 → `cont` 延续）（`packages/host/src/recovery.ts:53-113`）。
- **F2 补偿升级即阻断**：`COMPENSATION_ESCALATED` 未豁免 → `RECOVER/COMPENSATION-FAILED`（同文件 :89-97）；快照引用存在而存储缺失 → `RECOVER/SNAPSHOT-MISSING`（:98-109）。
- **F3 `keel recover` 已经在同一会话下开新 run**，并写 `RUN_RECOVERED{newRunId, recoveredFromSeq}`（`apps/keel/src/cmd-recover.ts:79-102`）。
- **F4 恢复后的驱动是 demo driver、没有历史**：`cmd-recover` 里 `decide` 只调一次工具就收尾（同文件 :82-90）；`wireRun` 也不传 `turnInput`（`apps/keel/src/runtime.ts:449-459`）。所以今天"恢复"在语义上只是"补偿 + 空上下文续一个新 run"。
- **F5 一致点语义**：`CHECKPOINT` 之前的事件已 fsync，之后可能只到页缓存；读取遇撕裂即停（`packages/core/src/ledger.ts:156-175,204-216`）。
- **F6 补偿按 run 范围**：`compensate(ref, {mode:"run"})` 只处理该 runId 的未决效果（`packages/host/src/compensator.ts:220-240`）；新 run 不继承未决效果（契约 §4.5 作用域澄清）。

## 3. 语义定义

### 3.1 什么算"接着干"

| 前一个 run 的终态                  | 路径 | 历史来源                                          | 是否补偿 | 是否挂快照 |
| ---------------------------------- | ---- | ------------------------------------------------- | -------- | ---------- |
| `halted`（正常收尾/预算优雅终止）  | 续跑 | 会话投影（全量，含该 run 全部表面事件）           | 否       | 否         |
| `failed`（协议违规/超时/引擎退出） | 续跑 | 同上（失败 run 已按终态流程收束，未决效果已处理） | 否       | 否         |
| 无终态（进程被杀/断电）            | 恢复 | 会话投影**截到该 run 最后一个 `CHECKPOINT.seq`**  | 是       | 是         |
| 不存在（新会话）                   | 新跑 | 空                                                | 否       | 否         |

- **为什么恢复要截到一致点**：一致点之后的事件可能落盘（页缓存已可见），也可能不落；更重要的是，一致点之后声明的副作用会被补偿回滚。若把一致点之后的工具结果给模型看，模型会看到"文件写成功了"而实际已被删除——**视图与副作用不一致**。截到一致点，语义就是契约一直声称的"从一致点恢复"。
- 代价：丢失最后一段对话。这是可接受的：不可接受的是"看起来接着干、实际状态错位"。

### 3.2 入口与自动判定

```
keel run --profile P --session S [--input text]
  ├─ 取会话租约（失败 → SCHED/BACKPRESSURE，零写入）
  ├─ 无 run ................. 新跑
  ├─ 最后 run 有终态 ........ 续跑
  └─ 最后 run 无终态 ........ 恢复（先 plan/execute，再开新 run）
keel recover --data-dir D --run R [--input text]   # 显式入口，向后兼容
```

- 自动判定只看**最后一个 run（最大 `sessionRun`）**：会话内不允许并行 run（01 稿 §3.3），所以不存在"中间有洞"的正常形态。
- 显式 `keel recover` 与自动路径共用同一实现；显式入口保留是为了运维与复演（既有测试与文档依赖）。

### 3.3 新 run 的装配顺序（硬约束）

1. 取会话租约（01 稿）。
2. （恢复路径）`RecoveryManager.plan(oldRef)`：一致点、未决效果、快照。
3. （恢复路径）`execute`：全 run 补偿 → 快照挂载 → 回调。
4. 装配（profile / 单件）→ `wireRun`（`recoveredFrom` 存在时 `RUN_RECOVERED` 写在新 run 首事件槽）。
5. `scheduler.start`：`assembly`（逐插件记录）、`turnInput`、**历史**。
6. 引擎驱动从历史继续（`EngineDriver` 的 `projectSession` 输入），每步照旧 `engine.step`。

- `turnInput`：续跑与恢复都必须写一条。续跑 = 用户这次的真实输入；恢复 = `--input` 原文，缺省 `"continue"`（确定性、可测试）。
- 历史与新输入的关系：`messages = projectSession(history, {includeCompacted:false})`，随后 `TURN_INPUT` 由调度器追加——两者不重复（历史里没有本次输入）。

### 3.4 失败与阻断

| 情形                                | 处置                                               | 码                                |
| ----------------------------------- | -------------------------------------------------- | --------------------------------- |
| 补偿升级未豁免                      | 拒绝恢复，原 run 保持现状，新 run 不创建           | `RECOVER/COMPENSATION-FAILED`     |
| 账本有快照引用、存储缺失            | 拒绝恢复                                           | `RECOVER/SNAPSHOT-MISSING`        |
| 旧 runId 不存在                     | 拒绝恢复                                           | `RECOVER/RUN-UNKNOWN`             |
| 会话租约被活着的进程持有            | 拒绝（不是恢复，是并发）                           | `SCHED/BACKPRESSURE`              |
| 恢复中途失败（挂载/装配）           | 新 run 不写 `RUN_STARTED`，旧 run 事实不变，可重试 | 沿用各自错误码                    |
| 续跑时投影重算失败（账本撕裂/损坏） | 拒绝续跑，提示用显式 `recover`                     | `LEDGER/CURSOR-INVALID`（不新增） |

- **错误码零新增**：全部复用既有码；语义差异放在 `detail`（如 `{phase:"compensate"|"mount"|"resume"}`）。

## 4. Engine 驱动的恢复（切片③的落点）

- 现状 `EngineDriver` 的构造是 `{cell, engine, ledger, ref}`（`packages/host/src/engine-driver.ts`）；它每步用 `projectSurface(ledger.read(ref))` 算上下文。Phase 5 改为注入 `history: SurfaceMessage[]`（由 `projectSession` 预先算好），每步 `messages = history + 本 run 新增表面事件投影`。
- 这样 engine 仍不读账本、不跨 run（禁面 E3 不变），历史由 Core 在 `engine.step` 入参里给。
- 恢复路径要拿到"新 Cell 上的引擎声明"：既有 profile 装配会重新拉起引擎 Cell，`assembleProfile` 的 `runId` 用新 runId 即可；快照经 `cell.migrate` 挂载在 `serve` 之前（`apps/keel/src/runtime.ts:442`）。

## 5. 验收映射（E2）

| 步骤 | 断言                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | run1 在"文件已写、模型还在想"时被强杀：账本尾部可能缺最后一条，`readRunMeta.terminal === "none"`                                        |
| 2    | `keel run --session S` 自动走恢复；`RecoveryManager.plan` 报出未决效果与一致点                                                          |
| 3    | 新 run 首事件 = `RUN_RECOVERED{recoveredFromSeq = checkpoint.seq}`，随后 `RUN_STARTED{sessionRun}` / `ASSEMBLY_RECORDED` / `TURN_INPUT` |
| 4    | 新 run 的模型视图最后一条来自旧 run 的**一致点之前**；一致点之后的表面事件不在视图里                                                    |
| 5    | 补偿完整回放（`COMPENSATION_EXECUTED` 齐全、无 `ESCALATED`）；另一并行会话正常收尾                                                      |
| 6    | 显式 `keel recover --run` 行为不变（向后兼容），并同样带历史                                                                            |

## 6. 风险与待决

- 风险 1：一致点截断让用户觉得"少了一截"——在 CHANGELOG 与 `sessions show` 里如实标注"恢复自一致点 seq=N"；不做静默拼接。
- 风险 2：恢复路径与 profile 装配的初始化顺序（补偿会不会需要旧 Cell？）——补偿执行器是宿主内建/插件补偿 Cell，不依赖旧 run 的引擎 Cell（F6 与 Phase 3 证据）。
- 风险 3：硬杀时租约残留导致自动恢复被误拒——租约 TTL + pid 存活判定；测试覆盖"进程已死、租约未过期"。
- 待决：恢复后是否要往视图里追加一条"已从一致点恢复"的系统说明？**建议不加**：说明属于 UI/呈现层，账本事实已足够；加了就多一条会进模型的表面事件。留 backlog。
