# ADR-0026：压缩是视图操作（复用 `surfaceOp` vs 新增表面事件）

- 状态：**草稿**（2026-11-04 起草；两案对比与建议已完成，等待所有者第二道闸拍板——[phase-5 合同](../roadmap/phase-5-session-continuity.md) §8 K4）
- 日期：2026-11-04
- 关联：[phase-5 合同](../roadmap/phase-5-session-continuity.md) §6 S6；[ADR-0021](ADR-0021-session-ledger-topology.md) 决策 3/4（白名单封闭、`surfaceOp` 预留）；[ADR-0024](ADR-0024-surface-event-family.md)（表面事件族只由 Core 写）；[ADR-0003](ADR-0003-model-gateway.md)（模型调用统一经网关）；[ADR-0025](ADR-0025-session-stream-addressing.md)（复合地址，压缩区间依赖它）；[research/01](../research/01-dsh-data-flow-survey.md) §4（DSH：压缩是视图操作、原始事件永留）；[设计稿 03](../design/phase-5/03-compaction.md)
- 取代：无（落地 ADR-0021 决策 4 的预留）

## 背景

Phase 4 给压缩留了形状没给实现：`SurfaceOp {kind:"compress"|"redact", fromSeq?, toSeq?, note?}` 只允许出现在表面事件上，本阶段不实现（`packages/core/src/events.ts:356-365`）。Phase 5 要实现压缩，必须先回答"压缩在账本里长什么样"。

约束是硬的：① 原始事件永不改删（I3、ADR-0021 决策 1）；② 摘要由模型生成，必须经网关（ADR-0003），计费/超时/失败收束一条不少；③ 摘要只能进模型视图，不能进治理与归因；④ 投影仍是纯函数、可重算、可还原。

两个候选：A 复用预留的 `surfaceOp`，挂在一条既有表面事件上；B 新增一条表面事件类型承载压缩事实。

## 事实核对（现状，带证据）

- **F1 `surfaceOp` 无载荷位**：只有 `kind/fromSeq/toSeq/note`（`events.ts:360-365`）——没有摘要正文、没有模型调用引用、没有投影版本、没有"为什么压"。
- **F2 白名单封闭三类**：`TURN_INPUT` / `MODEL_MESSAGE` / `TOOL_RESULT`（`events.ts:81`）；新增成员按 ADR-0021 决策 3 必须走 ADR。
- **F3 投影是纯 fold**：`projectSurface` 逐事件产出消息（`surface.ts:45-85`）；它现在只做"翻译"，不做"筛选"。
- **F4 写权结构不变**：Cell 无账本写通道，表面事件只能 Core 写（ADR-0021 决策 5、ADR-0024）；压缩由 Core 侧发起，不违反。
- **F5 DSH 的实况**：压缩是 `compaction/start → summary（含 shadowedSeqs）→ replace 版 user/message → compaction/end`，原始事件永留；tool-result 裁剪只许改 content（research/01 §4）。
- **F6 摘要调用会留下治理事实**：一次摘要 = 一条 `MODEL_INVOKED` + 一条 `MODEL_USAGE`（网关既有行为），预算预扣/结算成对。

## 方案 A：复用 `surfaceOp`（挂在一条表面事件上）

1. 压缩时写一条 `TURN_INPUT`（`role:"system"`），正文 = 摘要，`surfaceOp:{kind:"compress", fromSeq, toSeq}`。
2. 投影遇到带 `surfaceOp` 的事件：把区间的旧消息遮蔽，把本条作为摘要消息发出；区间定址依赖 ADR-0025 的复合地址。
3. 不改白名单、不新增事件类型；`surfaceOp` 从"预留"变成"已实现"。

问题：**一条用户输入同时是"摘要"又是"视图操作"**。投影必须对它做特例（不能当普通 user 消息发出）；`surfaceOp` 载荷装不下 `usageRef` / 投影版本 / 触发原因；审计方从外表看不出"这里发生过压缩"，只能靠字段约定去认。

## 方案 B：新增表面事件 `SURFACE_COMPACTED`

1. 新事件类型 `SURFACE_COMPACTED` 进白名单（三类 → 四类）；载荷：
   `{ summary, shadowed: [{from:{runId,seq}, to:{runId,seq}}], reason:"manual"|"threshold", usageRef:{reqId}, projectionVersion }`
2. 投影：压缩标记是**视图节点**——遇到它时把它前面的被遮蔽区间丢掉，发出 `{role:"system", content:summary}`；标记自身不进模型消息。
3. 语义规则：后写的标记覆盖先写的（嵌套压缩时"最新摘要为准"）；被更晚标记遮蔽的旧标记连摘要一起丢弃；原始事件一直在账本里。
4. `surfaceOp` **保持预留**，只服务另一类操作（单条表面事件的 `redact` 裁剪）——它与"会话级压缩"不是同一件事。

## 对比

| 维度       | A 复用 `surfaceOp`                          | B 新增 `SURFACE_COMPACTED`                   |
| ---------- | ------------------------------------------- | -------------------------------------------- |
| 语义清晰度 | 一条 user 输入承担两义，投影特例            | 压缩是一等事实，名字即语义                   |
| 审计/可读  | 只能靠字段认；replay/observe 要额外解释     | 事件类型直读；UI/观测面天然可展示            |
| 载荷空间   | 装不下 `usageRef`/版本/原因                 | 形状自由，可随需要追加字段                   |
| 白名单     | 不改（仍是三类）                            | 改（四类），按 ADR-0021 决策 3 走 ADR        |
| 兼容       | 旧账本无 `surfaceOp`，读方本来就要容错      | 新事件类型；旧账本按"无标记"读，等价不压缩   |
| 还原       | 需要"忽略 surfaceOp"的开关                  | 同样需要 `includeCompacted` 开关，语义更直白 |
| 演进       | 以后要加压缩元数据就得再改 `surfaceOp` 形状 | 只加字段，不动事件类型                       |

## 建议

**选 B（新增表面事件）**，理由按权重：

1. **压缩是可审计的持久事实**，不是某条消息的修饰。审计、重放、观测、将来的 UI 都要能直接回答"这个会话在什么时候、基于哪些事件、用哪个模型压过"——B 一条事件全说清，A 要靠约定拼。
2. **`surfaceOp` 的预留本来就是"等知道形状再定"**；现在知道形状了，而形状需要摘要、区间、调用引用与版本，塞进用户输入只会让投影和读方都做特例。
3. **白名单扩一条的代价可控**：ADR-0021 决策 3 已经规定"改白名单走 ADR"——本篇就是那个 ADR；旧账本按"无标记"读，兼容面小。
4. **职责正交**：`surfaceOp` 留给"单条事件裁剪"（redact），压缩是"会话级视图节点"；两者混用会让以后每一项都要在同一字段里做分派。

A 的成立条件是"绝不想让压缩出现在事件表里"。本项目的事件表本就是审计面，这个条件不存在。

## 决策（2026-11-04 所有者拍板：待第二道闸）

- [ ] 选 A（复用 `surfaceOp`）
- [ ] 选 B（新增 `SURFACE_COMPACTED`）

## 后果

- 积极：压缩成为账本里可直读的事实；投影仍是纯 fold（标记是节点，不是旁路开关）；原始事件永留，`includeCompacted` 可还原未压缩视图。
- 代价 / 风险：① 事件类型 +1、白名单 +1，读方要认新类型（旧账本不受影响）；② 摘要可能编造，必须钉死"只进模型视图、永不进治理/归因"；③ 压缩打断 KV cache 前缀，成本上升，只观测不设阈值。
- 重评条件：若压缩需要多级摘要树/hierarchical summary，B 只加字段（`shadowed` 已有区间语义）；若需要"改单条内容"的脱敏，走 `surfaceOp.redact`，不并入本事件。
- **被否方案**：A（理由见上）；C "压缩时删旧事件"——违反 I3 与 append-only，直接否决。
