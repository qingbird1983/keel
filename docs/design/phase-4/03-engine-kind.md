# Phase 4 切片①设计稿 03：`kind:"engine"`（Cell 里的最小 ReAct 循环）

- 状态：**草稿**（待所有者评审——第二道闸；过闸后转定稿方可开工切片④）
- 日期：2026-11-04
- 关联：[phase-4 合同](../roadmap/phase-4-profile-engine-loop.md) §2/§5 D3/D5/§6 B1/B5/C2~C5/§8 K2；[契约 §4.1/§4.6/§4.8/§5](../design/phase-1/01-core-api-contract.md)；[ADR-0011](../adr/ADR-0011-cell-load-gate.md)（装载门）；[ADR-0013](../adr/ADR-0013-model-stream-pull-chunking.md)（模型流终局）；[ADR-0021](../adr/ADR-0021-session-ledger-topology.md)（统一流 + 表面投影，已定稿）；[01 稿](01-profile-assembly.md)（装配与 scope）；[02 稿](02-model-kind.md)（模型调用面）

## 1. 本稿回答什么

engine 插件**跑在哪、谁驱动、每一步怎么和 Core 交换、上下文谁装配、崩了算谁的**。本稿不写具体 ReAct 提示词（标杆实现期定），只钉通道与治理形状。

## 2. 事实对账

- **F1 今天的"决策者"是宿主函数**：`RunDriver.decide()` 在 Host 进程内被调度器逐轮调用（`apps/keel/src/cmd-run.ts:70-75`），不是插件；`wireRun` 只收单份 manifest（`apps/keel/src/runtime.ts:402-435`）。
- **F2 Cell→Core 面没有"执行工具"这一项**：`auth.check` / `budget.query` / `model.*` / `tool.discover|register|remove` / `ledger.read` / `effect.declare` / `workspace.write`（`packages/host/src/cell-server.ts:60-121`）。工具执行是 Host→Cell 方向（`tool.exec`，`packages/cell-runtime/src/cell.ts:303-349`）。
- **F3 通道是一请求一响应**：请求帧强制带 `timeoutMs`（`packages/cell-runtime/src/protocol.ts:1-12`）；`EventFrame` 有形状但**没有发送方**（`cell.ts:227-228`）。推式/长连接事件不可用，也不做（合同 §2）。
- **F4 轮的治理边界在 Core**：`ROUND_STARTED → DECISION → 工具授权/执行 → 效果 → CHECKPOINT → ROUND_ENDED`；`DECISION` 带 `basedOn` + `throughSeq`（`packages/core/src/scheduler.ts:286-313,544-553`；ADR-0008）。`ASSEMBLY_RECORDED` 是 run 首事件（`scheduler.ts:255`）。
- **F5 模型调用在 Cell 侧已有通道**：engine 作为 Cell 可直接 `model.invoke`/`model.stream.*`，授权来自 `model.adapter`（`permission-rules.ts:18-26`）。
- **F6 工具可见面按 scope 分区**：`ToolCatalog` 以 scope 为键（`packages/core/src/tool-catalog.ts:29-92`）；跨 scope 互不可见是既有不变量（C1 回归）。
- **F7 快照与恢复按轮**：`CHECKPOINT` 缝会向 Cell 要 `cell.snapshot`（`runtime.ts:287-297`；ADR-0004）。

## 3. 决策（E 编号；E1/E3 待所有者拍板）

- **E1 循环位置（待拍板）**：**循环的决策逻辑在 engine Cell，回合的推进在 Core**。Core 每步发一次 `engine.step`（Host→Cell，请求/响应），engine 在一步内：装配好的消息 + 工具清单 → 调模型（`model.invoke`/`model.stream.*`，Cell 内发起）→ 返回**决策**（工具调用列表 / 终结 / 摘要）。Core 校验决策、执行工具（既有 `tool.exec`）、结算效果与预算、写账本，再把结果作为下一次 `engine.step` 的入参。**不新增 Cell→Core 的"执行工具"op**。
  - 为什么不选"engine 一次 run 到底、自建工具通道"：那要给 Cell 新开 `tool.invoke` op（新的治理面 + 新的授权词表），而 Core 本来就拥有工具执行的完整治理链（授权、hook、效果、补偿、检查点）；发明第二条执行链等于让治理出现两个入口（I1 风险）。
  - 代价：跨进程"一步一次往返"（本地 stdio 亚毫秒级，参照 ADR-0013 的同类论证）；engine 不再是一个"长驻循环进程"，而是"每步被喂入上下文、返回决策"的插件——**这恰好让它在崩溃后无状态可丢**。
- **E2 无状态引擎**：engine Cell **不持有权威状态**。每步入参由 Core 给出（表面投影的消息 + 工具清单 + 上一步的结果）；Cell 内的累积器只是缓存，崩溃即丢。由此：C5"防污染"不需要靠 engine 自觉——它**没有任何写账本/表面事件的通道**（F2 现状），想污染也没有入口。
- **E3 `engine.step` 协议（待拍板）**：

  ```
  Host → Cell  engine.step
    { runId, step, maxSteps, messages: SurfaceMessage[], tools: ToolSpec[], lastResult?: ToolResult[] }
  Cell → Host
    { decision: { kind: "act", actions: [{ tool, params, toolCallId }] }
              | { kind: "done", summary } }
  ```

  - 响应形状**封闭**：未知字段、未声明的工具名、超过 `maxSteps` 的继续请求一律拒绝（`SCHED/MANIFEST-INVALID`? 不——运行期用既有 `TRANSPORT/BADFRAME` 语义？见 §6）。
  - 一步请求时限：取契约 §7 的 **300s 档**（一步内最多含一次流式模型调用），不新增数字；空闲看门狗归模型插件（02 稿 M5）。
- **E4 上下文的装配者仍是 Core**（C2/C4 的落地）：递进 `engine.step` 的 `messages` = 按 ADR-0021 的**纯投影**从账本算出；工具清单 = 本 run 的工具目录（按 scope 过滤）；engine 不读账本、不写账本（`ledger.read` 对它可选关闭，首版不给）。消息形状至少 `{role, content, reasoning?, toolCalls?, toolCallId?}`——**`reasoning` 原样保留并回传**：DeepSeek 思考模式默认开启，带工具的请求漏传历史思考内容会直接 400（[research/02](../research/02-deepseek-api-survey.md) §3/§9），这是表面词汇必须留字段的硬理由，不是可选优化。
- **E5 决策入账与归因**（D5）：Core 收到 `decision` 后写 `DECISION{actions, summary, basedOn}`，`basedOn` 至少引用本步的 `MODEL_INVOKED`/`MODEL_USAGE` 与上一步 `TOOL_RESULT`；`throughSeq` 由账本盖章。engine 自己写不了账本，所以归因链只有一条（无第二条写者）。
- **E6 崩溃语义**（D3/B5）：kill engine Cell → 调度器收到舱退出 → 本轮 `RUN_FAILED{reasonCode:"ENGINE_EXITED"}` → 在途模型流按 ADR-0013 终局收束（已产出结算、`truncated`）→ 已声明未结算 effect 由补偿执行器按状态机收束 → 账本完整、并行 run 不受影响（既有 cell-crash 语义，不新增错误码）。**不做自动重启**：重启即"新 run"，属会话持久化范围（合同 §2 不做）。
- **E7 终结与预算**：`done` 只在预算未耗尽且未触发 stop hook 时被接受；预算耗尽时下一跳 `model.invoke` 直接 `BUDGET/EXHAUSTED`，Core 按既有 `onRunExhausted` 收束（`hard-stop` 与 `graceful` 都走既有路径）。`maxSteps` 是最后一道闸（超限 = `RUN_HALTED{reasonCode:"MAX_STEPS"}`），与预算相互独立。
- **E8 禁面（K6 的 engine 半边）**：engine 源码禁 `node:http|https|net|tls`、禁 `process.env`、禁 `ledger.*` 写入面、禁注册 policy hook、禁 import 宿主包；manifest 侧 engine 只允许 `model.adapter` 一项能力（不出网、无文件系统、无记忆后端），装配器语义校验强制（越界能力对 engine 直接拒绝，不靠评审核对）。
- **E9 与 profile 的接口**：profile 的 engine 条目声明 `engine.model.ref`（指向 profile 里某个 model 插件的 `id` + 模型名）与 `engine.tools`（允许请求的工具名清单）。装配期交叉校验：model ref 必须命中；每个工具名必须**恰好一个**能力插件提供（重名 = 整份拒绝，避免"调谁"的歧义）；未列出的工具即使存在也拒绝（未声明 = 不存在）。

## 4. engine manifest 段（v1）

```json
{
  "kind": "engine",
  "permissions": [{ "cap": "model.adapter", "reason": "ReAct 每步调用模型" }],
  "engine": {
    "loop": "react",
    "model": { "ref": "model-mock", "name": "mock-chat" },
    "tools": ["fs-read", "fs-write"],
    "maxSteps": 12
  }
}
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `loop` | 是 | 首版仅 `"react"`；未知值拒绝（不猜语义） |
| `model.ref` | 是 | profile 内 model 插件 `id`；装配期必须命中 |
| `model.name` | 是 | 该插件 `model.models` 之一 |
| `tools` | 是 | 非空字符串数组；每个名字装配期唯一命中一个能力插件 |
| `maxSteps` | 是 | 1~100；超限装配期拒绝 |

## 5. 一步的时序（机制核心）

1. Core `ROUND_STARTED` → 从账本投影出 `messages` + 工具清单；
2. Core → engine `engine.step`；
3. engine 内：`model.invoke`/`model.stream.*`（网关：授权 → 预扣 → `MODEL_INVOKED` → `MODEL_USAGE` → settle）；
4. engine 返回 `decision`；
5. Core 校验 → `DECISION` 入账 → 逐个 action：`auth.check`（工具执行）→ hook① → `tool.exec` → 效果声明/结算 → `TOOL_RESULT`；
6. Core `CHECKPOINT`（既有快照缝）→ `ROUND_ENDED` → 回到 1，或按 `done` 收束。

## 6. 错误与违规

- engine 返回未知工具名 / 非法形状 → **拒绝该步**并 `RUN_FAILED{reasonCode:"ENGINE_PROTOCOL"}`（detail 带字段路径）；不静默忽略、不"尽力执行"。
- engine 请求超过 `maxSteps` → `MAX_STEPS` 收束。
- `engine.step` 超时（300s 档）→ 按 `TRANSPORT/TIMEOUT`（结果未知）→ 本轮失败，在途模型按 ADR-0013 收束。
- 不新增错误码（全部复用既有域）。

## 7. 验收映射（D3/D5）与红测先行

| 场景 | 机械断言 |
| --- | --- |
| D3 真进程多步闭环 | mock 剧本 3 步（模型→工具→模型→终结）：独立 engine Cell、file-write 真写盘、补偿在环；账本事件序完整 |
| D3 故障半径 | kill engine Cell：`RUN_FAILED`、在途模型收束、effect 补偿、并行 run 继续 |
| D5 可重放归因 | 每步 `DECISION.basedOn` 覆盖模型事件与上一步工具结果；按账本重放能复现决策序列 |
| 协议封闭 | 未声明工具、未知字段、超 maxSteps 各一条拒绝用例 |

红测先行：`tests/engine-kind-e2e.test.ts`（真进程，切片④开工时红→绿）。

## 8. 自检清单

- [ ] engine 没有新的工具执行通道；工具执行仍只有 Core 一条链
- [ ] engine 无状态可丢，且没有任何写账本/写表面的入口
- [ ] 每步消息由 Core 投影给出（ADR-0021 的纯投影），engine 不自行装配
- [ ] 未声明工具 = 不存在；重名工具 = 装配期拒绝
- [ ] 崩溃、超时、超步数三种收束都有账本证据，且不新增错误码
- [ ] engine manifest 只允许 `model.adapter` 一项能力（语义校验强制）

## 9. 确认记录与待拍板

- **E1 已确认（2026-11-04）**：决策在 Cell、推进在 Core（`engine.step` 每步一往返）；**不**新开 Cell→Core 的工具执行通道。
- **E3 待拍板**：`engine.step` 的请求/响应字段与"一步取 300s 档"时限。
