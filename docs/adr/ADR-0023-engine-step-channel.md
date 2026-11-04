# ADR-0023：`engine.step` —— 引擎决策与核心推进的分工通道

- 状态：定稿（2026-11-04，随切片①设计稿 01~04 所有者过闸；[03 稿](../design/phase-4/03-engine-kind.md) 已定）
- 日期：2026-11-04
- 关联：[phase-4 合同](../roadmap/phase-4-profile-engine-loop.md) §6 B1/§8 K2；[契约 §3.1/§4/§7](../design/phase-1/01-core-api-contract.md)；[ADR-0013](ADR-0013-model-stream-pull-chunking.md)（流式终局）；[ADR-0022](ADR-0022-manifest-kind-extension.md)（engine kind）；[research/01](../research/01-dsh-data-flow-survey.md) §2.1（跨进程只传结算事件）
- 取代：无

## 背景

engine 要跑"调模型 → 调工具 → 结算 → 喂回 → 终结"的多步循环，但 Keel 的 Cell→Core 面里**没有**"执行工具"这一项（`cell-server.ts:60-121`），工具执行是 Host→Cell 方向（`tool.exec`）。两条路摆在面前：

- **A** engine 一次 `run` 到底，自建循环，并新开 Cell→Core 的 `tool.invoke`（第二条工具执行链）；
- **B** 每步一次 Host→Cell 请求，engine 只做决策，Core 保持原有工具执行与记账链。

A 的问题不在工程量，而在**治理出现两个入口**：工具执行的授权、hook①、效果声明、补偿、检查点都在 Core 的调度器里（`scheduler.ts:286-313,439-479`），再开一条 Cell 发起的执行链，就等于允许"绕开调度器也能跑工具"——与 I1 直接冲突。A 还要求一次请求跨整个循环（远超 §7 任何一档时限），与"一请求一响应"的帧协议不变式（`protocol.ts:1-12`）打架。

## 决策

1. **新增一个 Host→Cell op**：`engine.step`。
   - 请求：`{runId, step, maxSteps, messages, tools, lastResult?}`
   - 响应：`{decision:{kind:"act", actions:[{tool, params, toolCallId}]} | {kind:"done", summary}}`
2. **循环的决策在 Cell，回合的推进在 Core**：一步内 engine 可调模型（既有 `model.invoke`/`model.stream.*`），随后返回决策；Core 校验决策、执行工具、结算、写账本，再发下一步。**不新增 Cell→Core 的工具执行 op。**
3. **响应形状封闭**：未知字段、未在 `engine.tools` 声明的工具名、超出 `maxSteps` 的请求一律拒绝——运行期按 `RUN_FAILED{reasonCode:"ENGINE_PROTOCOL"}` 收束（不新增错误码）。
4. **时限取契约 §7 既有 300s 档**（一步内最多含一次流式模型调用），不新增数字；到点按 `TRANSPORT/TIMEOUT`（结果未知）处置。
5. **engine 无权威状态**：`messages` 由 Core 按 ADR-0021 的投影给出；Cell 内的累积器只是缓存，崩溃即丢。决策入账由 Core 写 `DECISION`（`basedOn` 引用本步模型事件与上一步工具结果）。
6. **崩溃不自动重启**：Cell 退出 → 本轮 `RUN_FAILED{reasonCode:"ENGINE_EXITED"}`，在途模型流按 ADR-0013 终局收束，效果按补偿状态机收束；重启属会话持久化范围（合同 §2 不做）。

## 理由

- 工具执行链全仓只剩一条（调度器），I1 不需要靠"审计 engine 有没有乱调工具"来保证，而是结构上没有第二条路。
- 每步 bounded（≤300s）符合帧协议与 Supervisor 的超时/强杀模型；也让"崩溃 = 本轮失败"有明确边界。
- engine 无状态后，"engine 写坏上下文"这个风险类别消失——它没有写账本/写表面的入口（03 稿 E2/C5）。

## 后果

- 积极：工具授权、hook、效果、补偿、检查点全部沿用既有路径；engine 可整行替换而不动治理。
- 代价 / 风险：① 每步一次跨进程往返（本地 stdio 亚毫秒级，ADR-0013 同口径论证）；② engine 不能"连续思考多轮不返回"，每步必须交还控制权——这是有意的治理边界；③ 消息与工具清单每步序列化，长上下文时 payload 变大（后续压缩/分页属下一阶段）。
- 重评条件：出现"单步必须跨多次模型调用且不允许中途交还"的真实需求时，再评估长驻 run 通道（须同时给出工具执行的新治理方案，否则不采纳）。
- **被否方案**：A 一次 `run` + `tool.invoke`（两个执行入口）；C engine 放 Host 进程内（等于放弃 Cell 隔离，与 K2 冲突）；D 让 engine 直接 `tool.exec` 调别的 Cell（跨 scope 可见性被破坏，且绕过 Core 的授权与效果链）。
