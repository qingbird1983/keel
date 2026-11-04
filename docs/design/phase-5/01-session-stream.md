# Phase 5 切片①设计稿 01：会话流（读取面、顺序、单活、跨 run 投影、会话预算）

- 状态：**定稿**（2026-11-04 起草并定稿：所有者第二道闸拍板 K2 选 A 复合键；本稿按 A 写）
- 日期：2026-11-04
- 关联：[phase-5 合同](../../roadmap/phase-5-session-continuity.md) §2/§5 E1·E4·E5·E6/§6 S1~S4·S7；[ADR-0025](../../adr/ADR-0025-session-stream-addressing.md)（定址，待拍板）；[ADR-0021](../../adr/ADR-0021-session-ledger-topology.md)（统一流 + 表面投影）；[ADR-0004](../../adr/ADR-0004-ledger-consistency-point.md)（run 内单写者与一致点）；[ADR-0008](../../adr/ADR-0008-decision-attribution-upper-bound.md)（归因口径）；[契约 §4.4/§4.5/§5](../../design/phase-1/01-core-api-contract.md)

## 1. 目标与边界

把"同一 `(agentId, sessionId)` 下的多个 run"接成一条**有序、可按游标读取、可纯函数投影**的会话流；在此之上给出续跑入口（`keel run --session`）与会话预算的账本投影。

本稿只覆盖会话流本身；续跑/崩溃恢复的分界见 [02 稿](02-resume-and-recovery.md)，压缩见 [03 稿](03-compaction.md)。

## 2. 事实核对（带证据）

- **F1 目录已按会话分层**：`<root>/<agentId>/<sessionId>/<runId>/seg-NNNNNN.jsonl`（`packages/core/src/ledger.ts:4`）。
- **F2 run 内 seq 单调、单写者**：`seq` 写队列分配（同文件 :139-140）；已有账本的 run 拒绝第二写者（:279-286）；恢复一律新 runId（契约 §4.5）。
- **F3 跨 run 读取不存在**：`ledger.read` 必填 `runId`（:47-52），只能自己扫目录。
- **F4 目录名无序**：`run-<uuid8>`（`apps/keel/src/cmd-run.ts:101`）。
- **F5 投影是纯函数、不看 runId**（`packages/core/src/surface.ts:45-85`）。
- **F6 会话预算在内存**（`packages/core/src/budget.ts:43-46,61-62`），但 `BUDGET_RESERVED/SETTLED` 已带 `sessionRemaining`（`packages/core/src/events.ts:212-232`）。
- **F7 两条入口的会话不一致**：单件路径 `sess-${runId}`（`apps/keel/src/runtime.ts:427`）；profile 路径缺省 `"main"`（`packages/host/src/profile/assemble.ts:140-142`）。

## 3. 数据与接口定义

### 3.1 会话身份与顺序（S1 / S2）

```ts
/** 会话身份 = 信封里已有的两组 id，不新增对象。 */
interface SessionRef {
  agentId: string;
  sessionId: string;
}

/** 会话内的 run 序号（1 起、单调整数）；落 RUN_STARTED 追加字段，见 §4 R1。 */
type SessionRunOrdinal = number;

/** 会话流里的一条事件 = 账本事件 + 它所属 run 的序号。 */
interface SessionEvent {
  runOrdinal: SessionRunOrdinal;
  runId: string;
  event: LedgerEvent; // 信封原样，seq 仍是 run 内编号
}
```

- **顺序 = `sessionRun` 升序**，同一 run 内 = `seq` 升序。**没有第三种顺序**（不按文件 mtime、不按目录名）。
- **序号分配**：宿主在会话租约内读当前最大值 `max(sessionRun) + 1`，写入本 run 的 `RUN_STARTED.sessionRun`。分配与写入之间只有本进程，租约保证无并发；崩溃在 `RUN_STARTED` 之前 = 什么都没写（空目录由收尾清理），之后 = 序号被消耗、该 run 成为"无终态 run"，交给恢复路径（02 稿）。
- **旧账本兼容**：没有 `sessionRun` 的 run（Phase 4 及以前）按 `RUN_STARTED.ts` 升序、`runId` 字典序兜底，**全部排在编号 run 之前**；新 run 从 `max(编号)+1` 起。旧 run 之间顺序可能不完美（同毫秒并发），这是历史账本的已知上限，写进契约注记。
- **不改**：信封、`seq` 语义、`basedOn`/`throughSeq` 的 run 内口径（ADR-0025 若选 A）。

### 3.2 读取面（S1 / S7）

```ts
interface SessionReadFilter {
  types?: EventType[]; // 复用 run 级过滤语义
  from?: { run: SessionRunOrdinal; seq: number };
  limit?: number; // 默认 500，上限 2000
}

interface SessionPage {
  events: SessionEvent[];
  nextCursor: string | null; // 不透明：base64url({o, r, s})
}

interface SessionRunMeta {
  runId: string;
  ordinal: SessionRunOrdinal | null; // null = 旧账本无编号
  startedAt: number | null; // RUN_STARTED.ts
  terminal: "halted" | "failed" | "none"; // 读最后一段判定；none = 无终态
  lastSeq: number;
}

interface SessionSummary {
  ref: SessionRef;
  runs: SessionRunMeta[];
  lastRunId: string | null;
  activeRunId: string | null; // 有租约或最后一个 run 无终态
}
```

- **不物化索引文件**。会话流由目录扫描 + `ledger.readRunMeta` 派生；账本仍是唯一事实，避免"索引与账本不一致"的第二个写者与第二套撕裂修复。
- `ledger.readRunMeta(ref)` 是**新增的 Core 内部读取面**（不进 Cell 通道）：先读首段取 `RUN_STARTED`，再倒读末段取最后一条事件判终态与 `lastSeq`；末段撕裂按既有语义"止于最后完整行"。
- `session.read` 的实现 = 对 `runs` 按序对每个 run 调既有 `ledger.read`（复用类型过滤与撕裂语义），跨 run 拼页；游标记录 `{序，runId, seq}`，恢复读取时从该 run 的该 seq 之后继续。
- **分页与性能**（S7）：默认页 500；`types` 过滤在 run 级提前生效。V1 不做"反向只取最近 N 条"，靠压缩控制上下文长度；基准记录 `summary` 的扫描成本与翻页成本（只测不设阈值）。

### 3.3 单活与租约（S2）

- 租约文件：`<root>/<agentId>/<sessionId>/.lease`，内容 `{runId, pid, host, acquiredAt, expiresAt}`。
- 获取：`open(path, "wx")`（`O_EXCL`），失败即冲突；**获取在任何账本写入与装配之前**（零写入断言）。
- 失效：同机 `pid` 不存活，或 `now > expiresAt`（默认 TTL 60s，checkpoint 时心跳续期）；跨机只有 TTL（单机 MVP，ADR-0002）。
- 释放：run 终态、`closeRuntime`、或进程退出钩子；释放失败留给 TTL 兜底。
- 冲突拒绝：`KeelError("SCHED/BACKPRESSURE", "session busy", {session, heldBy})`——**错误码零新增**；拒绝路径不写账本、不 spawn Cell。

### 3.4 会话预算投影（S4）

```ts
interface SessionBudgetUsage {
  used: number; // Σ settled.actual + Σ 未结算 reservation.estimate（保守上界）
  remaining: number | null; // null = 未配置限额
}
```

- 口径：按 `reservationId` 去重地折叠会话内全部 run 的 `BUDGET_SETTLED.actual`；对**有 `BUDGET_RESERVED` 而无同名 `BUDGET_SETTLED`** 的预扣，按 `estimate` 计入已用（不让崩溃漏账）。
- 超支：`BUDGET_SETTLED.overrun:true` 不特殊处理——`actual` 已如实记，`remaining` 夹到 0。
- 权威关系：**账本投影是权威**；`Budgeter` 在会话绑定（run 启动）时用投影值初始化 `sessionUsed`，之后运行期内仍按既有内存态推进与结算。
- 时机：只在会话绑定那一刻投影一次（O(会话内预算事件数)）；不每次结算重扫。单活保证运行期内无第二个写者改会话账面。

### 3.5 跨 run 投影（S3）

```ts
const SURFACE_PROJECTION_VERSION = 2;

function projectSession(
  events: readonly SessionEvent[],
  opts?: { includeCompacted?: boolean },
): SurfaceMessage[];
```

- 规则：按会话流顺序，对白名单事件套用既有 `SurfaceMessage` 映射；**跨 run 无特殊拼接标记**（用户输入本身就是边界）。
- 版本 2 的规则集**同时包含压缩标记的折叠**（03 稿），切片②实现跨 run 部分、切片④实现标记部分——版本号只在规则集变化时递增，不为"功能上线先后"递增。
- `toolCallId` 跨 run：模型生成的 id 在同一会话里由模型保证唯一；**Core 生成时改为 `runId` 前缀**（例如 `<runId>:<uuid>` 的截断形态不能破坏既有 `ToolResultPayload` 的字符串约束）——实施细则：Core 生成 id 时带上 `runId` 的短前缀，避免两个 run 的 `toolCallId` 相同导致投影配错。
- 重算一致性：同一事件流 + 同一版本 = 同一输出（纯函数、无时间/随机源）；测试用两个独立进程重算比对（E1）。
- 截断：V1 全量投影，不做滑动窗口；上下文过长由压缩处理（03 稿）。**理由**：投影可重算的前提是"输入确定"，任何隐式截断都会让"同一账本两次重算不同"。

### 3.6 CLI（S8 的会话部分）

| 命令                                                   | 语义                                                              | 退出码 |
| ------------------------------------------------------ | ----------------------------------------------------------------- | ------ |
| `keel run --profile P --session S [--input text]`      | 在会话 S 上开新 run；S 不存在 = 新建，存在 = 续跑（历史来自投影） | 0/1/2  |
| `keel sessions list --data-dir D [--agent A]`          | 列出会话：run 数、最后状态、最后时间                              | 0/1/2  |
| `keel sessions show --data-dir D --session S [--json]` | 打印模型视图（默认）或 `--raw` 原始事件流                         | 0/1/2  |

- `--session` 与 `--manifest/--plugin` 也允许组合（单件路径同样落到指定会话）；与 `--profile` 互斥规则不变。
- `sessionId` 过 `assertId`（路径段安全，`packages/core/src/ledger.ts:77-81`）。
- 未给 `--session` 时保持现状：单件路径 `sess-${runId}`，profile 路径 `"main"`——**不破坏既有测试与脚本**。

## 4. 契约修订点（详见 [04 稿](04-contract-revision.md)）

- **R1**：`RUN_STARTED` 载荷升 v2，追加 `sessionRun: number`（旧账本缺省）。
- **R2**：新增 Core 内部读取面 `ledger.readRunMeta(ref)`（不进 Cell 通道；无新 op）。
- **R3**：会话读取面 `session.read(filter, cursor)` 的游标形状与会话事件形状（仅 Host/CLI 使用）。
- **R4**：`SURFACE_PROJECTION_VERSION = 2`，投影规则集 = 跨 run + 压缩折叠。
- **R5**：会话租约冲突复用 `SCHED/BACKPRESSURE`，detail 加 `{session, heldBy}`；错误码零新增。
- **R6**：会话预算投影口径（`Σ settled.actual + Σ 未结算 estimate`）写入契约 §4.3 注记。

## 5. 验收映射

| 场景 | 本稿的落地 | 断言要点                                                                       |
| ---- | ---------- | ------------------------------------------------------------------------------ |
| E1   | §3.1/§3.5  | run2 视图含 run1 表面事件；两进程重算一致                                      |
| E4   | §3.2       | 读取只接受本 `(agent, session)`；越界 = `SCHED/NOT-FOUND` 语义（不泄漏存在性） |
| E5   | §3.4       | 新进程 run2 的 `used` 含 run1 的结算；预扣未结算也计入                         |
| E6   | §3.3       | 并发第二 run 被拒且目标 run 目录零字节；不同会话并发正常                       |

## 6. 风险与待决

- 风险 1：`session.read` 逐 run 拼接在 run 很多时变慢——V1 只记录基准；阈值触发后再做反向取数或派生索引（backlog）。
- 风险 2：旧账本同毫秒并发导致顺序不确定——已在契约注记声明；新账本靠 `sessionRun` 消除。
- 风险 3：租约在硬杀（`SIGKILL`）后残留——TTL 兜底；测试用注入时钟覆盖"过期即接管"。
- 待决：无（K2 已拍板选 A，[ADR-0025](../../adr/ADR-0025-session-stream-addressing.md) 定稿；本稿即最终口径）。

## 7. 实施注记（2026-11-04，切片②）

- `SessionEvent.runOrdinal` 落成**会话流位置**（1 起）：新 run 等于 `sessionRun`，旧账本没有编号但仍占位置；定址仍以 `(runId, seq)` 为准（R3 的复合键）。
- 版本覆盖选项落成 `loadProfile` 的可选 `sessionId`——profile 的插件 scope 在**装载期**就把顶层默认值固化了，装配后再改 `plan.scope` 不会传播到插件（详见 [04 稿](04-contract-revision.md) §8）。
- `sessions show --agent` 会核对会话存在性：读不到 = 拒绝，不返回"看起来空"的会话（E4 零泄漏）。
- 切片②未做：`--compact`（C2）、`includeCompacted` 还原开关、心跳续期（TTL 覆盖单次 run 即可）；均按 04 稿顺序留后续切片。
- 切片④补：`sessions show --full` = `includeCompacted:true`（还原压缩前视图）；压缩与续跑共用同一份会话投影，恢复路径的历史截断仍按一致点。
