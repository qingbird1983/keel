# ADR-0024：表面事件族（模型可见消息的词汇、白名单与写权）

- 状态：定稿（2026-11-04，随切片①设计稿 01~04 所有者过闸；依据 [ADR-0021](ADR-0021-session-ledger-topology.md) 已定的统一流拓扑）
- 日期：2026-11-04
- 关联：[ADR-0021](ADR-0021-session-ledger-topology.md)（统一流 + 纯投影）；[契约 §5](../design/phase-1/01-core-api-contract.md)（事件表）；[03 稿](../design/phase-4/03-engine-kind.md) E4；[04 稿](../design/phase-4/04-contract-revision.md) R1/R3；[research/01](../research/01-dsh-data-flow-survey.md) §2.3/§4（DSH 表面投影与插件记录防污染）；[research/02](../research/02-deepseek-api-survey.md) §3（思考内容必须回传）
- 取代：无

## 背景

ADR-0021 选了统一流：账本是唯一事实，模型视图是账本的纯投影。但"哪些事件能被投影"没有定——不定就会有两种坏结局：要么模型看见授权/预算/裁决（治理细节泄漏进提示），要么模型正文无处安放（重放不可行）。DSH 的反面教训正好在这里：插件记录走独立通道、强制 `ignorable` 且**不可带表面操作**（research/01 §4），即"可写日志"与"可进模型视图"必须是两个权限。

## 决策

1. **新增两条表面事件**（`schemaVersion:1`）：
   - `TURN_INPUT`：run 起始的输入，载荷 `{role:"user"|"system", content}`；
   - `MODEL_MESSAGE`：模型回答，载荷 `{content, toolCalls?:[{id,name,arguments}], reasoningContent?, usageSeq?}`。
2. **白名单封闭，首版只有三条**：`TURN_INPUT`、`MODEL_MESSAGE`、`TOOL_RESULT`。只有这三类进模型视图；`DECISION`/`AUTH_DENIED`/`BUDGET_*`/`HOOK_*`/`EFFECT_*`/`CHECKPOINT` 永远不投影。**加白名单必须走 ADR**，不因"看起来有用"临时加。
3. **写权只有 Core**：gateway 写 `MODEL_MESSAGE`，scheduler 写 `TURN_INPUT`（run 起始）与 `TOOL_RESULT`（既有）。Cell 侧没有任何直写账本的通道（`cell-server.ts:60-121`），engine 想污染也没有入口。
4. **投影是纯函数、带版本**：`project(events[0..n]) → messages[]`；消息形状 `{role, content, reasoning?, toolCalls?, toolCallId?}`；不落独立存储，缓存可丢、可重算。`reasoning` **原样保留并回传**——DeepSeek 思考模式默认开启，带工具时漏传历史思考内容直接 400（research/02 §3），所以它不是可选优化而是字段级要求。
5. **`surfaceOp` 只允许出现在表面事件上，本阶段不实现**：字段形状在契约修订中预留（C4），非法组合在写入校验层拒绝；压缩实现时再定 `replace`/`mask` 语义。
6. **执行顺序不变**：表面事件与治理事件共用一个 `seq`、一个 `checkpoint`、一套撕裂修复（ADR-0004）；不新增同步机制。

## 理由

- 白名单 + 纯投影把"模型看见什么"变成可审的静态集合，而不是散落在各处的拼接代码；也直接对接后续 ui 阶段的"显式白名单 + 整值投影"（research/01 §5）。
- 写权归 Core 后，"engine 防污染"不需要额外机制（C5 的答案就是"没有入口"）。
- `reasoningContent` 进表面事件，才谈得上"重放能复现请求"——否则重放出来的第二轮请求必然 400。

## 后果

- 积极：模型正文、工具结果、输入同源；重放与归因共用一条时间线；压缩将来是视图操作，原始事件不动。
- 代价 / 风险：① 账本字节增长（模型正文进账本），需靠基准观测（合同 §4）；② 投影是热路径，必须纯且被快照式测试钉死；③ 白名单误加一条 = 治理细节泄漏，评审时按"发布接口"对待。
- 重评条件：实现压缩时扩展 `surfaceOp`（另立 ADR）；若账本 IO 成为瓶颈，按 ADR-0004 重评有界合并（不改变本 ADR 的词汇与白名单）。
- **被否方案**：A 把模型正文塞进 `MODEL_INVOKED`/`MODEL_USAGE`（语义污染：计量事件变成载荷事件）；B 每步正文不落账、只留内存（重放与归因失效，D5 不成立）；C 插件可写表面事件（等于让被审者改自己的卷宗，DSH 已明确禁止）。
