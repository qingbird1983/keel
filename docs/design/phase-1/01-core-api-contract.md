# Keel Core API 契约

- 状态：定稿（2026-11-02 所有者确认；同日修订三处：① ADR-0005 定稿，回填 §7 隔离敏感超时；② 任务 D 成稿，§5 补充三类补偿事件；③ 所有者评审勘误与澄清——§4.3 configure 边界、§4.5 恢复补偿作用域、§6 错误码拆分；切片③实现期注记两处：§4.1 ④⑤、§5 ASSEMBLY_RECORDED；**2026-11-03 Phase 2 切片①追加：§3.3 与 §4.6 增 `tool.register`/`tool.remove` 两个 Cell→Core op，依据 [ADR-0010](../../adr/ADR-0010-runtime-tool-registration-channel.md)**）
- 日期：2026-11-02
- 关联：[architecture/01](../../architecture/01-keel-overview.md)；[ADR-0001](../../adr/ADR-0001-implementation-stack.md) ~ [ADR-0005](../../adr/ADR-0005-cell-isolation.md)；[phase-0](../../roadmap/phase-0-design-baseline.md)（验收 A2/A3）

## 1. 背景

DSH 三类症状直接源于控制面缺少硬契约：**V6** Agent Loop 被插件化（控制流可被替换）、**V3** 长程任务缺统一执行账本（不可恢复归因）、**V1** 全局工具注册污染跨会话上下文缓存。本文把 Core 七组件 + 策略扩展点的对外行为固定为契约——**接口即围栏**：插件的全部可见面在本表中，表外即不存在。

设计输入（所有者已确认，2026-11-02）：

- **D1 策略 hook 白名单**：最小否决型四件套（审批 / 停止建议 / 重试建议 / 预算耗尽选择），全部"建议/否决"型。
- **D2 预算作用域**：Agent ⊃ Session ⊃ Run 三级嵌套，子级从父级预留；MVP 实现 Run + Session，Agent 级接口保留。
- **D3 状态快照归属**：Core 账本只记"状态引用+版本"元数据；Host 层 Supervisor 在轮边界索取并持有快照；恢复 = 重建 Cell + 挂载快照 + 重放至一致点。

## 2. 目标与不覆盖

**覆盖**：通道与帧格式、契约可见面矩阵、七组件接口表、账本事件 schema、错误码、超时与重试、授权×预算交互时序、hook 白名单语义。

**不覆盖**：传输层实现（stdio 绑定仅约定帧格式）；Cell 内部 API 与进程管理（任务 B / ADR-0005）；manifest schema（任务 C）；补偿事务状态机（任务 D，本文只预留 EFFECT_DECLARED / COMPENSATION_EXECUTED 两类事件与核对钩子）；性能实现与基准。

## 3. 方案

### 3.1 通道与帧格式

- 唯一通道 = 结构化请求/事件（architecture/01 §4）；MVP 绑定 stdio JSON 行（ADR-0002 本机 IPC，按可远程化设计）。
- 请求：`{"id":"req-...","op":"auth.check","params":{...},"timeoutMs":50}`；响应：`{"id":"req-...","ok":true,"result":{...}}` 或 `{"id":"req-...","ok":false,"error":{"code":"AUTH/DENIED","message":"...","detail":{}}}`。
- 事件（单向通知）：`{"ev":"ROUND_STARTED","seq":123,...}`——即账本事件（§5）按订阅分发；订阅方（观测插件、Supervisor）不得反向写。
- 一切请求必须携带 `timeoutMs`（缺省用 §7 默认表）；`id` 在 Run 内唯一，幂等重试凭 `id` 去重。

### 3.2 ID 与作用域模型

三级 ID：`agentId`（Agent 实例）⊃ `sessionId`（会话）⊃ `runId`（一次 Agent Run = 一组调度轮）。作用域 scope = `(agentId, sessionId)`；Cell ↔ Run 一一对应。所有 context / tool / budget 接口以 scope 或 runId 为首参——**不存在无作用域的全局查询接口**（V1 的结构性防御）。

### 3.3 契约可见面矩阵（I1 的接口化）

| 调用方             | 可见接口                                                                                                                                                                                                            | 明确不可见                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Cell（含能力插件） | `auth.check`、`budget.query`、`model.invoke`、`tool.discover`（仅本 scope）、`tool.register`/`tool.remove`（仅本 scope，须声明 `tool.provide`，Phase 2 追加）、`context.*`（仅本 scope）、`ledger.read`（仅本 run） | 账本写入、调度、恢复、hook 配置、他人 scope 的一切 |
| 策略插件           | 四个 hook 被调用（被动），无主动接口                                                                                                                                                                                | 除 hook 入参外的一切                               |
| 观测插件           | `ledger.read`（全量只读）、事件订阅                                                                                                                                                                                 | 一切写接口                                         |
| Host Layer         | `run.*`、`recover.*`、`context.alloc`、快照存取、装配相关                                                                                                                                                           | 账本写入、授权/预算裁决（只能传递不能改判）        |

账本 `append` 与 `checkpoint` 仅为 Core 内部函数，不出现在任何对外命名空间——调度器是唯一写入者（单写者，ADR-0004）。

> 实现期细化（2026-11-03 Phase 2 切片①，[ADR-0010](../../adr/ADR-0010-runtime-tool-registration-channel.md)）：Cell 行追加 `tool.register` / `tool.remove`——**只携带工具名与 schema，永不携带 handler**（执行体留在 Cell 私有表，内核只认名字）；作用域与主体仍由通道绑定盖章，Cell 不可自报。二者是 Cell 可见面里唯一的**写**入口，故必须先过 `auth.check`（未声明 `tool.provide` 即拒并落 `AUTH_DENIED`），默认拒绝语义与 I4 一致。

## 4. 接口定义

表列约定：幂等性 = 同 `id` 重放是否安全。错误码见 §6。

### 4.1 调度器（Run 生命周期）

| op           | 方向      | 语义                                                                   | 默认超时                              | 幂等性                      | 主要错误                                       |
| ------------ | --------- | ---------------------------------------------------------------------- | ------------------------------------- | --------------------------- | ---------------------------------------------- |
| `run.start`  | Host→Core | 按 manifest 装配结果创建 Run；返回 runId；首轮调度随即开始             | 5s（含 Cell 冷启动，ADR-0005 后回填） | 是（同 runId 返回既有结果） | `SCHED/BACKPRESSURE`、`SCHED/MANIFEST-INVALID` |
| `run.cancel` | Host→Core | 请求停止：停止派发新轮，触发在途副作用补偿（任务 D），写 `RUN_HALTED`  | 2s                                    | 是                          | `SCHED/NOT-FOUND`                              |
| `run.status` | Host→Core | 查询状态机位置（running/halting/halted/failed/recovering）与最近一致点 | 100ms                                 | 是                          | `SCHED/NOT-FOUND`                              |

调度轮内部序列（不可插件化，V6 的结构性防御）：`ROUND_STARTED → 读上下文 → 策略 hook（如触发）→ 决策 → 执行（工具/模型，经授权+预算）→ 账本 → CHECKPOINT`。任何 hook 响应都不含"下一动作"字段——schema 层面拒绝（§5 HOOK_VERDICT）。

> 实现期细化（2026-11-02 切片②）：① 正常完成 = 末轮 `CHECKPOINT`+`ROUND_ENDED` 后写 `RUN_HALTED{reason:"completed"}`（终态 halted；事件表无 RUN_COMPLETED，复用 RUN_HALTED）；② 预算耗尽事件映射：hard-stop → `RUN_FAILED{reasonCode:"BUDGET/EXHAUSTED"}`、graceful → `RUN_HALTED{reasonCode:"BUDGET/EXHAUSTED-GRACEFUL"}`，收束序 = 补偿 → CHECKPOINT → ROUND_ENDED → RUN_*；③ 被拒动作（Core 授权或 hook① 否决）不产生 TOOL_INVOKE，以 `TOOL_RESULT{status:"error", error.code:"AUTH/DENIED", error.by: "core"|"policy-hook"}` 统一落点留痕。
>
> 实现期细化（2026-11-02 切片③）：④ Cell 进程退出三分类（ADR-0005）经 Supervisor `abort` 缝写 `RUN_FAILED`，原因码 `CELL/CRASH` / `CELL/KILLED` / `CELL/CLEAN-EXIT`（载荷级字符串，不扩 §6 错误码表）；abort 与 cancel 语义对偶——cancel → `RUN_HALTED`，abort → `RUN_FAILED`，在途轮先正常收束再落终态；⑤ 装配记录经 `ASSEMBLY_RECORDED` 于 `run.start` 作为首事件落账（§5 注记）。
>
> 实现期细化（2026-11-02 切片④）：⑥ 补偿触发三模式与调度缝映射——预算耗尽中断 → `verify`（补偿稿 T4：只核验未决、不回滚）；`run.cancel`/halt 收束 → `run`（T5：全 Run 回滚）；fail-stop → `run`（T3：全 Run 回滚，尽力收尾）。`EFFECT_SETTLED` 由宿主效果追踪器写入（executor 包装按工具结果映射：ok→`done`、error/timeout→`unknown` 保守，超时语义遵循 §6「结果未知」）；落点序 = `EFFECT_DECLARED` → `EFFECT_SETTLED` → `TOOL_RESULT`；⑦ 恢复延续：`RunManifest.recoveredFrom` 携带旧 runId 与一致点 seq，`RUN_RECOVERED{newRunId, recoveredFromSeq}` 于新 run 首事件槽写入（随 ASSEMBLY_RECORDED 槽位，先于 `RUN_STARTED`）。

### 4.2 授权器

| op                | 方向           | 语义                                                                   | 默认超时 | 幂等性 | 主要错误                            |
| ----------------- | -------------- | ---------------------------------------------------------------------- | -------- | ------ | ----------------------------------- |
| `auth.check`      | Cell/网关→Core | 判定 `subject × action × resource`；结果必写 `AUTH_DENIED`（拒绝留痕） | 50ms     | 是     | `AUTH/DENIED`、`AUTH/SCOPE-UNKNOWN` |
| `auth.policy.get` | Host→Core      | 读取当前生效授权策略版本（诊断用，只读）                               | 100ms    | 是     | —                                   |

授权策略本身为 Core 配置（白名单 + 默认拒绝，fail-closed，standards/06 §4）；策略插件不参与授权裁决（审批类需求走 hook①，且仅"否决权"无"授予权"——不能放行 Core 策略已拒绝的调用）。

### 4.3 预算器（D2）

| op                 | 方向                    | 语义                                                                | 默认超时 | 幂等性               | 主要错误                                   |
| ------------------ | ----------------------- | ------------------------------------------------------------------- | -------- | -------------------- | ------------------------------------------ |
| `budget.reserve`   | Core 内部（授权后调用） | 按估算预扣；返回 `reservationId`；作用域链自 Run 向上逐级检查并预留 | 50ms     | 是（同 id 同额）     | `BUDGET/EXHAUSTED`、`BUDGET/SCOPE-UNKNOWN` |
| `budget.settle`    | Core 内部               | 按权威计量实结，退还差额；写 `BUDGET_SETTLED`                       | 50ms     | 是（同 id 结算一次） | `BUDGET/RESERVATION-UNKNOWN`               |
| `budget.query`     | Cell（只读本 run）      | 查询剩余额度与已耗用量                                              | 50ms     | 是                   | —                                          |
| `budget.configure` | Host→Core               | 设置某 scope 限额（MVP：配置文件装载，接口预留热更新）              | 200ms    | 是                   | `BUDGET/INVALID-LIMIT`                     |

- 层级模型：`agent ⊃ session ⊃ run`；子级 reserve 同时在祖先链预扣，settle 逐级实结。MVP 实现 run + session；`agent` 级接口签名保留（§12）。
- 耗尽语义三档（按 scope 配置，默认 Run=hard-stop、Session=graceful）：**hard-stop** 立即停止派发并走补偿收尾；**graceful** 完成在途工具调用+补偿后停，不接受新副作用；**policy** 交 hook④ 在 Core 给定的 `{hardStop, graceful}` 中选（D1 与 D2 的衔接点）。
- 边界澄清（2026-11-02 修订）：`budget.configure` 只设置 scope 限额**参数**，不改变任何已发生的 reserve/settle 裁决；运行时预算裁决仍由预算器独立执行——与 §3.3 "Host 只能传递不能改判"不矛盾：配置限额 ≠ 运行时改判。
- 实现注记（2026-11-02 切片②）：模型调用重试（上游失败后，§8 失败路径）派生 `reqId#n` 级 reservation——失败试次以 settle(0) 闭环（settle-once 语义不动），重试以新 reservation 实结真实用量；总计费仍权威，不变式不变。

### 4.4 账本

| op                  | 方向                            | 语义                                                    | 默认超时 | 幂等性 | 主要错误                          |
| ------------------- | ------------------------------- | ------------------------------------------------------- | -------- | ------ | --------------------------------- |
| `ledger.read`       | 观测插件 / Cell（本 run）/ Host | 按 filter（runId/scope/类型/seq 区间）+ cursor 流式读取 | 1s/批    | 是     | `LEDGER/CURSOR-INVALID`           |
| `ledger.checkpoint` | Core 内部                       | 轮边界 flush+fsync，写 `CHECKPOINT`（ADR-0004）         | —        | —      | `LEDGER/WRITE-FAILED` → fail-stop |

写路径纪律：轮内事件异步缓冲追加；`CHECKPOINT` 强制落盘；写失败 = 本轮 fail-stop（`RUN_FAILED`，禁止"先跑后补记"）。事件 schema（§5）单调 `schemaVersion`，只追加不改写。

### 4.5 恢复器（D3）

| op                | 方向      | 语义                                                                                                                                 | 默认超时               | 幂等性              | 主要错误                                                  |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------- | --------------------------------------------------------- |
| `recover.plan`    | Host→Core | 给出恢复计划：最近一致点 seq、需核对的未决副作用清单（`EFFECT_DECLARED` 未闭环者）、快照引用+版本                                    | 1s                     | 是                  | `RECOVER/RUN-UNKNOWN`                                     |
| `recover.execute` | Host→Core | 执行恢复：核对/执行未决补偿（按任务 D 状态机）→ Supervisor 重建 Cell 并挂载快照 → 从一致点重放 → 以新 runId 延续，写 `RUN_RECOVERED` | 30s（ADR-0005 后回填） | 是（同 runId 幂等） | `RECOVER/COMPENSATION-FAILED`、`RECOVER/SNAPSHOT-MISSING` |

顺序硬约束（ADR-0004 §4.4）：**先核对未决副作用补偿表，再续跑**——恢复流程不得跳过 `recover.plan` 的补偿清单。
作用域澄清（2026-11-02 修订）：未决效果的补偿与核对在**原 runId 作用域内**完成；补偿闭环（或豁免）后，才以新 runId 延续。新 runId 不继承任何未决效果。

> 实现期细化（2026-11-02 切片④）：补偿动作经**新补偿 Cell 进程**通道执行（同插件一次性 spawn、跑完即弃——ADR-0005「Host 侧上下文（或新 Cell）」路径；私有 op `compensation.exec`，未知 actionRef 拒绝，重试 ≤3 次/退避 ≤30s 钳制随补偿稿 §6）；快照挂载复用 `cell.migrate` 通道（入参 oldState = 快照，迁移钩兼作恢复挂载点，manifest 稿 §5.5 注记）；`RUN_RECOVERED` 作为新 run 首事件（§4.1 注记⑦）；`execute` 前置 = 旧 run 已终态（failed/halted）；快照 MVP = 宿主内存持有 + 账本 `STATE_SNAPSHOT_REF` 元数据（物理持久化登记 backlog）。

### 4.6 上下文管理器

| op                    | 方向                     | 语义                                                                                             | 默认超时 | 幂等性                           | 主要错误                           |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ | -------- | -------------------------------- | ---------------------------------- |
| `context.alloc`       | Host→Core（Cell 建立时） | 创建 scope 私有分区（工具表视图、上下文页、记忆命名空间），返回分区句柄                          | 200ms    | 是（同 scope 幂等）              | `CTX/SCOPE-EXISTS`                 |
| `tool.discover`       | Cell→Core                | 返回**本 scope** 可见工具表（含 schema 版本）；无全局模式                                        | 100ms    | 是                               | `CTX/SCOPE-UNKNOWN`                |
| `tool.register`       | Cell→Core                | 本 scope 注册/更新工具（`{name, schema}`，**不含 handler**）；版本由内核按现有条目 +1 指派并返回 | 200ms    | 否（重复调用 = 覆盖且版本再 +1） | `AUTH/DENIED`、`CTX/SCOPE-UNKNOWN` |
| `tool.remove`         | Cell→Core                | 本 scope 撤名（`newSchemaVersion=0` 传播）；返回是否真的存在过                                   | 200ms    | 是（第二次返回 false）           | `AUTH/DENIED`、`CTX/SCOPE-UNKNOWN` |
| `context.page.out/in` | Core 内部                | 换页原语：旧页移出/按需移回，页版本入账本                                                        | —        | —                                | `CTX/PAGE-MISSING`                 |

工具 schema 变更 = 显式事件 `TOOL_SCHEMA_CHANGED`，**仅传播到受影响 scope**（V1：动态增删工具不触碰其他会话缓存）。

> 实现期细化（2026-11-03 Phase 2 切片①，[ADR-0010](../../adr/ADR-0010-runtime-tool-registration-channel.md)）：`tool.register` / `tool.remove` 的落地口径——① **门禁在前**：handler 内先 `auth.check(ref, subject, "tool.register"|"tool.remove", name)`，拒绝即 `AUTH_DENIED` 落账且两半状态都不写；授权规则由 manifest 声明编译（`tool.provide` → 两个 action；`allow` 给了就逐条收窄）。② **两半提交**：Cell 先写私有执行表、跨通道成功后才算完成；通道失败则回滚执行表并把内核错误码原样抛给插件（不留"可见而不可执行"的空壳）。③ **版本单一事实源**：Cell 不自算版本，内核按本 scope 现有条目 +1 后返回真实值。④ **生效时刻 = 下一轮**：写 scope 挂起变更日志，由调度器在轮边界取走并写 `TOOL_SCHEMA_CHANGED`；末轮之后的注册不入账（run 已结束）。⑤ 承接层不做通道级重试（重复调用就是旧框架的覆盖语义）。

> 实现注记（2026-11-02 切片②）：MVP 落地 scope 分区 + `tool.discover` + schema 变更按 scope 传播（scope 级挂起变更日志，各 run 按游标消费后写入本 run 账本，同 scope 多 run 不丢事件）；`context.page.out/in` 换页原语随上下文页存储后端在 Phase 1 后续切片落地。
>
> 实现注记（2026-11-02 切片④）：`context.page.out/in` 原语落地——per-run 页注册表、内存后端（`pageOut` / `pageIn` / `pageVersion`；页不存在或未移出即取 = `CTX/PAGE-MISSING`）；页版本经 `CONTEXT_PAGED` 事件写入本 run 账本（§5）。物理页存储后端登记 backlog。

### 4.7 模型网关（ADR-0003）

| op             | 方向      | 语义                                                                                                            | 默认超时               | 幂等性                 | 主要错误                                                    |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------- | ----------------------------------------------------------- |
| `model.invoke` | Cell→Core | 授权 → `budget.reserve`（预扣估算）→ Core 持凭证代理调用 → `settle`（权威计量）→ 写 `MODEL_INVOKED/MODEL_USAGE` | 120s（非流式）         | 是（同 id 不重复计费） | `GATEWAY/UPSTREAM-ERROR`、`AUTH/DENIED`、`BUDGET/EXHAUSTED` |
| `model.stream` | Cell→Core | 同上，流式透传；用量以流结束时机网关计量为准                                                                    | 连接 300s / 首字节 30s | 否（流式不重放）       | 同上                                                        |

Cell 侧适配器无凭证、无直连网络能力；网关故障 = 发起 Cell 本轮失败（`RUN_FAILED`），不级联其他 Cell。

### 4.8 策略扩展点（D1：封闭白名单，仅此四个）

| hook                         | 触发点                    | 允许的响应                               | 响应 schema 禁区                          |
| ---------------------------- | ------------------------- | ---------------------------------------- | ----------------------------------------- |
| `hook.toolApproval`          | 工具执行前                | `{verdict:"approve"\|"deny", reason}`    | 不可改写工具参数/目标                     |
| `hook.stopAdvice`            | 每轮决策后                | `{suggestStop:bool, reason}`             | Core 裁决是否采纳；不含动作               |
| `hook.retryAdvice`           | 工具/调用失败后           | `{policy:"give-up"\|"retry", backoffMs}` | 受 Core 上下限钳制（max 3 次、退避 ≤30s） |
| `hook.budgetExhaustedChoice` | 预算耗尽且该 scope=policy | `{action:"hardStop"\|"graceful"}`        | 只能在 Core 给定选项中选                  |

共性硬规则：同步调用、默认超时 200ms；**hook 失败/超时 = 采用默认策略并记 `HOOK_VERDICT{fallback:true}`**；每次调用与裁决入账本（归因）；白名单封闭——新增 hook 类型必须 ADR（防"变相接管"，architecture/01 §10）。

## 5. 事件表（账本 schema）

公共信封：`{seq(单调), ts, runId, sessionId, agentId, type, schemaVersion, payload}`。

| type                                                          | 载荷要点                                                                     | 备注                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| RUN_STARTED / RUN_HALTED / RUN_FAILED / RUN_RECOVERED         | 生命周期与原因码                                                             | RUN_RECOVERED 含新 runId 与恢复自 seq                                                                                                      |
| ASSEMBLY_RECORDED                                             | manifest 名/版本/kind、权限清单、补偿 class 摘要、record-only 标记、接受与否 | 装配审计基线（manifest 稿 §6 第 5 步）；切片③注记：run.start 时作为该 run 首事件写入，run 前失败的装配尝试不入账本（由装配器错误返回承载） |
| ROUND_STARTED / ROUND_ENDED                                   | 轮号                                                                         | ROUND_ENDED 前必见 CHECKPOINT                                                                                                              |
| DECISION                                                      | 决策内容摘要 + 依据事件 seq 引用                                             | V6 重放归因的锚点                                                                                                                          |
| TOOL_INVOKE / TOOL_RESULT                                     | 工具、参数摘要、结果状态、耗时                                               | 参数全文按留存策略（任务 C manifest 声明）                                                                                                 |
| AUTH_DENIED / HOOK_CALLED / HOOK_VERDICT                      | 主体、hook 名、裁决、fallback 标记                                           | 拒绝与策略介入全留痕                                                                                                                       |
| BUDGET_RESERVED / BUDGET_SETTLED                              | reservationId、scope 链、估算/实结、层级余量                                 |                                                                                                                                            |
| MODEL_INVOKED / MODEL_USAGE                                   | 模型、请求摘要；用量/费用权威计量                                            | 网关写入（ADR-0003）                                                                                                                       |
| EFFECT_DECLARED / COMPENSATION_EXECUTED                       | 副作用声明与补偿闭环                                                         | schema 归任务 D → **已细化**（[补偿状态机](02-compensation-state-machine.md) §9）                                                          |
| EFFECT_SETTLED / COMPENSATION_ESCALATED / COMPENSATION_WAIVED | 效果结果 / 补偿升级 / 豁免                                                   | 同上（任务 D 增量，载荷见其 §9）                                                                                                           |
| STATE_SNAPSHOT_REF                                            | 快照引用 + 版本 + 轮号                                                       | D3 元数据；Core 不含快照内容                                                                                                               |
| TOOL_SCHEMA_CHANGED                                           | 工具、旧/新 schema 版本、受影响 scope                                        |                                                                                                                                            |
| CONTEXT_PAGED                                                 | 页 ID、方向 out/in、页版本                                                   | 换页审计（§4.6 注记；切片④新增，落本 run 账本）                                                                                            |
| CHECKPOINT                                                    | 一致点 seq、轮号                                                             | ADR-0004；重放自校验锚                                                                                                                     |

## 6. 错误码

分域字符串 `DOMAIN/KIND`。完整表：

| 码                                                                                                       | 语义               | 可重试                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------- |
| `AUTH/DENIED`                                                                                            | 授权拒绝（必留痕） | 否（改请求或改策略）                            |
| `AUTH/SCOPE-UNKNOWN`、`CTX/SCOPE-UNKNOWN`、`CTX/SCOPE-EXISTS`、`SCHED/NOT-FOUND`                         | 寻址类             | 否                                              |
| `BUDGET/EXHAUSTED`                                                                                       | 作用域链额度耗尽   | 否——触发 §4.3 耗尽语义                          |
| `BUDGET/RESERVATION-UNKNOWN`、`LEDGER/CURSOR-INVALID`、`RECOVER/RUN-UNKNOWN`、`RECOVER/SNAPSHOT-MISSING` | 状态类             | 否                                              |
| `SCHED/BACKPRESSURE`、`SCHED/MANIFEST-INVALID`                                                           | 准入类             | 退避后是 / 否（修 manifest）                    |
| `GATEWAY/UPSTREAM-ERROR`                                                                                 | 模型上游失败       | 按 hook③ 策略                                   |
| `LEDGER/WRITE-FAILED`                                                                                    | 账本写失败         | 否——fail-stop，走恢复                           |
| `RECOVER/COMPENSATION-FAILED`                                                                            | 补偿失败           | 否——升级阻断（补偿状态机 §8），豁免或修复后可续 |
| `TRANSPORT/TIMEOUT`、`TRANSPORT/BADFRAME`                                                                | 通道类             | 幂等请求是                                      |

约定：错误必须带 `code`；`TRANSPORT/TIMEOUT` 时**执行结果未知**——调用方不得假设未发生，必须经补偿核对路径确认（衔接任务 D）。

## 7. 超时与重试基线

| 交互                                          | 默认超时                                     | 重试                                       |
| --------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `auth.check` / `budget.*`                     | 50ms                                         | 幂等重试 ≤2 次，退避 20ms 起               |
| `tool.discover` / `context.*` / `run.status`  | 100~200ms                                    | 同上                                       |
| hook 四件套                                   | 200ms                                        | 不重试（fallback=默认策略）                |
| `run.start`                                   | 5s（含 Cell 进程冷启动，ADR-0005）           | 幂等重试安全；容器后端启用时重估并修订本表 |
| `model.invoke` 非流式 / 流式首字节 / 流式总长 | 120s / 30s / 300s                            | 幂等（同 id 不重复计费）/ 不重试           |
| `recover.execute`                             | 30s（含 Cell 进程重建 + 快照挂载，ADR-0005） | 幂等                                       |
| `ledger.append`（内部）                       | 缓冲写，<10ms                                | CHECKPOINT 强制 flush                      |

重试总闸：hook③ 的 retry 建议被 Core 钳制（≤3 次、退避 ≤30s）；一切重试与结果入账本。

## 8. 授权 × 预算交互时序（以模型调用为例）

```text
Cell        Core(auth)      Core(budget)     Gateway      账本
 │ invoke ──▶│ check          │                │            │
 │           │──grant──▶      │ reserve(估算)  │            │
 │           │                │──reservationId▶│ 调用上游    │
 │◀──────────┼────────────────┼────stream/resp─┤            │
 │           │                │ settle(实结)   │            │
 │           │                │──退还差额────▶ MODEL_USAGE ─┤
 │◀── result + usage ─────────┴────────────────┴────────────┘
 失败路径：deny → AUTH_DENIED 入账本（不留 reservation）
           预算不足 → BUDGET/EXHAUSTED → 耗尽语义（§4.3）
           上游失败 → settle(0) 退还 → GATEWAY/UPSTREAM-ERROR → hook③
```

不变式：**无 reservation 不执行；无 settle 不算完成**——预算权威记账的时序保证（ADR-0003）。

## 9. 验收（契约级测试点，对应 phase-0 A2 / 验收用例）

- [ ] **V6**（Agent Loop 被插件化）：hook 响应 schema 拒绝含"下一动作/工具名/参数"字段的载荷；重放任一 Run 的 `HOOK_*` + `DECISION` 事件可完整归因每次策略介入。
- [ ] **V3**（缺统一账本）：kill -9 模拟中断 → `recover.plan` 正确给出最近 CHECKPOINT 与未决 `EFFECT_DECLARED` 清单 → `recover.execute` 后 Run 以新 runId 延续且 `RUN_RECOVERED` 可追溯。
- [ ] **V1**（全局注册污染）：`tool.discover` 无 scope 参数即报错；两个 scope 各自增删工具，`TOOL_SCHEMA_CHANGED` 互不可见，缓存命中率不受扰动。
- [ ] **预算权威**：同 id 重放 `model.invoke` 不重复计费；settle 差额退还逐级可见（session 余量 = run 结算后回吐）。
- [ ] **拒绝留痕**：任何 `AUTH/DENIED` 必有账本事件；策略插件 hook 超时必有 `HOOK_VERDICT{fallback:true}`。

> 基准与复演口径（2026-11-02 切片⑤）：A8 四项基准的测量口径与 CLI 验收命令面见 [04-cli-benchmarks-fixtures](04-cli-benchmarks-fixtures.md)——只建测量不调优，无阈值断言；数据供 ADR-0001/0003/0004 重评条件消费。

## 10. 自检清单（五大不变量对照）

- **I1 控制不可旁路**：§3.3 可见面矩阵——账本写入/调度/恢复/授权裁决不出现在任何插件可见命名空间；hook 白名单封闭且响应 schema 禁区化（§4.8）→ V6。
- **I2 故障不可级联**：一切接口显式超时（§7）；hook 失败=默认策略；网关故障=发起 Cell 本轮失败（§4.7）；无跨 Cell 共享可变接口。
- **I3 状态不可丢失**：CHECKPOINT 一致点 + `STATE_SNAPSHOT_REF` + `recover.*` 顺序硬约束（§4.5）；账本写失败 fail-stop（§4.4）。
- **I4 副作用不可无痕**：`EFFECT_DECLARED` 先于越界执行；恢复必核对未决补偿（§4.5）；超时=结果未知必须核对（§6）。状态机细节归任务 D，本文为其预留事件与钩子。
- **I5 上下文不可全局污染**：一切 context/tool 接口 scope 为首参；无全局查询接口存在（§3.2）；schema 变更按 scope 传播（§4.6）→ V1。

## 11. 风险

| 风险                                          | 预案                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| 契约过早冻结                                  | 本篇"评审中"；实现中发现缺陷先改本文（standards/03 §1.4），接口变更记 CHANGELOG |
| hook 超时链累积（四 hook 串行最坏 +800ms/轮） | 白名单内触发条件互斥设计；实现期熔断；基准入 Phase 1 验收                       |
| stdio 帧与未来远程传输漂移                    | §3.1 已按可远程化约束（id/显式超时）；Phase 2+ 仅换传输层                       |
| 快照 I/O 拖慢轮边界                           | D3 快照异步预取 + CHECKPOINT 前完成性校验；基准不达标回评（登记 backlog）       |

## 12. 待决问题

| 问题                                                                 | 决定时限                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ledger.read` 游标语义（持续追加流的消费/滞留）细节                  | Phase 1 实现期细化，不阻塞定稿                                        |
| `model.stream` 背压与断流恢复语义                                    | Phase 1 基准后回填                                                    |
| `budget.configure` 的 Agent 级配置入口（所有者工具 or 配置文件热载） | MVP 用配置文件；接口已预留                                            |
| 隔离敏感超时回填                                                     | ✅ 已解决：ADR-0005 定稿，§7 已回填（2026-11-02）；容器后端启用时重估 |
