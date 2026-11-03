# ADR-0013：`model.stream` 的通道形状（拉式分片）与流式记账时序

- 状态：定稿（2026-11-03 所有者确认，见切片⑤设计稿 [phase-2/07](../design/phase-2/07-contract-revision-and-backfill.md) §7 第 3 项）
- 日期：2026-11-03
- 关联：契约 [§4.7 模型网关 / §6 错误码 / §7 超时表 / §12 待决问题](../design/phase-1/01-core-api-contract.md)；[ADR-0003](ADR-0003-model-gateway.md)（网关唯一通道与预扣/实结不变式）；[ADR-0008](ADR-0008-decision-attribution-upper-bound.md)（追加字段的兼容口径）；[ADR-0010](ADR-0010-runtime-tool-registration-channel.md)（新增 Cell→Core op 的先例）；[phase-2 合同](../roadmap/phase-2-cordis-compat.md) §2「做」回填项 ④；切片⑤设计稿 §2 事实核对（F10/F11/F12/F13）与 §3.4
- 取代：无——本篇**落地契约 §4.7 已列出但零实现的 `model.stream`**，并关闭契约 §12 的"背压与断流恢复语义"待决问题；`model.invoke` 的语义、四 hook、账本事件类型集合全部不动

## 背景

契约 §4.7 里 `model.stream` 这一行从 Phase 1 就写着（流式透传、用量以流结束时网关计量为准、连接 300s/首字节 30s、**不重放**），§7 还给它配了三档时限——但实现侧什么都没有：`ModelGateway` 只有 `invoke`，`ModelUpstream` 接口只有 `invoke`，全仓 `stream` 零命中。Phase 1 报告 §10 的回填清单把它列在案，合同 §2「做」第 4 条（所有者确认）把它纳入 Phase 2。

真正要定的是**通道形状**，因为帧协议今天是严格的**一请求一响应**：`FrameConn.respond()` 每次请求只写一帧（`protocol.ts` 158-181），`handleLine` 收到首条同 id 响应即 resolve 并从 pending 表删除、**迟到帧直接丢弃**（211-224）；事件帧（`{"ev": …}`）在协议里有形状、两侧都能收，但**全仓没有任何发送方**。推式流式因此不是"加一个 op"，而是要同时新开事件帧发送面、给分片建立与请求的关联、处理迟到与乱序，并作废"单请求单响应"这条被 Supervisor 三处超时（`supervisor.ts` 199-208 的强杀计时与请求超时）和 fail-stop 语义依赖的不变式。

另外两件事顺带要定：权限面（能力词表是封闭枚举，`model.adapter` 今天只编译出一条 `model.invoke` 规则）与断流时的计量口径（半途断掉，钱算不算、算多少）。

## 决策

1. **通道形状 = 拉式分片**，三个新 Cell→Core op：
   - `model.stream.start {reqId, model, params, estimate}` → `{streamId, chunks[], done, usage?, cost?}`
   - `model.stream.next {streamId, limit?}` → `{chunks[], done, usage?, cost?}`
   - `model.stream.cancel {streamId}` → `{settled: bool}`
     分片由**调用方逐次取**，每一片仍是一请求一响应。`chunks` 是上游已产出部分的有序数组。
2. **背压由构造消解**：消费方不 `next` 就不产不攒，内核侧会话缓冲有上限（超限即停止从上游取片，等消费方取走）。契约 §12 那条"背压与断流恢复语义"的**背压一半就此关闭**——不需要新协议机制。
3. **记账时序四条不变式一条不松**（ADR-0003 的原话仍成立）：授权一次 → `budget.reserve`（estimate）一次 → `MODEL_INVOKED` 一次（载荷追加 `streamId`）→ **每片不写任何事件** → 流终了写 `MODEL_USAGE{usage, cost, truncated}` 并 `settle(权威计量)` → **无 settle 不算完成**。理由：账本按轮增长已经够审计用，按 token 写事件会把账本体积变成流长度的函数（ADR-0008 决策 3 反对的是同一件事）。
4. **断流口径 = 按已产出部分结算**：`next` 超时 → `TRANSPORT/TIMEOUT`，按契约 §6"结果未知"处理——会话标为中断，`settle(已用量)` 并退还剩余预扣，`MODEL_USAGE.truncated:true`，发起方本轮按既有失败路径处置（`RUN_FAILED` 或 hook③ 重试建议，**不级联其他 Cell**）。不静默全额退还（那等于宣称这次调用没花钱，而分片已经给出去了），也不静默丢弃。
5. **幂等 = 流式不重放**（§4.7 既有立场）：同 `reqId` 在会话**未终**时再次 `start` 返回同一 `streamId`（不重打上游、不重复预扣）；会话已终则返回既有终态结果并标 `replay:true`。
6. **权限随既有词表编译，报关单零扩展**：`model.adapter` 这一项能力编译出**两条**授权规则（`model.invoke` + `model.stream`）。不新开 cap——新开属词表扩展（manifest 稿 §5.2 明文须 ADR），而"能不能调模型"与"以什么形状调"是同一项权威的两个入口，不是一新一旧的能力。
7. **时限全部取契约 §7 既有三档，不新增数字**：`start` 的响应 = 首字节 30s；`next` 的单次等待上限 = 同一档 30s（语义是"一次取片的等待上限"）；会话总长 300s 由内核计时，到期即走第 4 条的断流口径。
8. **载荷扩展按类型记版本**：`MODEL_INVOKED`/`MODEL_USAGE` 因追加字段在类型级版本表（切片⑤ §7 第 1 项）里升到 2，其余事件仍为 1；读方对缺字段一律按"无该信息"处理——与 ADR-0008 决策 4 同一口径，Phase 1 旧账本继续可读。
9. **承接层不开流式旧面**：旧 `ctx.llm.*` 一条都不放行（边界表 #6 的 C 档立场不变）；本片只补一个护栏——`ctx.llm` 的**未知成员**（如 `chatStream`）也显式抛 `ADAPTER/UNSUPPORTED` 并写明改法去处，取代今天的裸 `TypeError`。真样本暴露出具体旧符号时按 B5 义务补边界表行，不在这里替旧框架发明 API。
10. **上游适配器加可选 `stream?()`**：未实现流式的上游被请求 `model.stream.start` → 显式失败（复用 `GATEWAY/UPSTREAM-ERROR` + `detail.reason:"UPSTREAM_NO_STREAM"`，不新开码）。

## 理由

- 拉式不动"一请求一响应"= Supervisor 的超时与强杀逻辑、装载门（ADR-0011）的就绪凭据、通道 fail-stop 全部原样成立；改动半径局限在网关与一个会话表。
- 分片经多次往返的代价在本地 stdio 上是亚毫秒量级（每片一次），而推式换来的是协议不变式作废——第 3 项的账本膨胀风险也随推式而来（每片都想留痕）。
- 断流按已产出部分结算是唯一同时满足两条既有主张的口径：预算权威（内核说了算）与不假装没花钱。

## 后果

- 积极：回填项 ④ 兑现，§12 的待决问题从两条减到零；流式与预算/归因第一次在同一套不变式里；`keel bench` 因此有可测的流式开销口径（切片⑥复采）。
- 代价 / 风险：① 首片延迟 = 上游产出 + 一次通道往返，**"流式透传"是形状上的重新解释**，契约 §4.7 要写修订注记而不是照字面读；② 会话状态住在内核进程里，宿主重启即全部中断（与快照持久化无关，Phase 3 若要"续流"需另立决策）；③ 缓冲上限的具体数字属实现期参数，本 ADR 不锁数字。
- 重评条件：出现"必须低首片延迟的真流式（长连接/边产边推）"的真实需求时，重新评估推式事件帧方案。
- 被否方案：**A 推式事件帧**（分片走 `EventFrame` + 末帧响应）——最贴合"透传"字面，但要新开事件帧发送面、分片-请求关联、迟到帧处理，并作废单请求单响应不变式；**B 推给 Phase 3**——合同 §2「做」第 4 条是所有者已确认的回填项，推后属范围变更；**C 让 Cell 直连上游 SSE**——直接违反 ADR-0003/§4.7"Cell 无凭证、无直连网络"，等价于把网关架空。

## 实施注记（2026-11-03 施工期追加；只补事实，不改上面任何一条决策）

1. **终局是四条，不是三条**。决策 4 写了"上游结束 / 断流 / 取消"，施工时撞上第四条：**上游 `stream()` 中途抛**。处置 = 先按断流口径闭环（settle 已产出部分 + `MODEL_USAGE{truncated:true}`），再把 `GATEWAY/UPSTREAM-ERROR{detail.reason:"STREAM_UPSTREAM_THROW", produced, cost}` 报给发起方——**不**像慢断流那样把半截内容连 `done:true` 一起交回去。两条路径的读法差别是真的：慢是"结果未知、已给的算钱"，抛是"上游明确失败"，把后者包装成一次正常结束就是静默降级。测试面：`packages/core/test/gateway-stream.test.ts`（出 2 片后抛 / 一片没出就抛）+ `tests/model-stream-channel.test.ts`（真舱）。
2. **两个数字是实现期参数，两个时限不是**：默认页 16 与单次缓冲上限 64 是 `stream.ts` 的实现常量（拉式下没有真正的缓冲压力，64 只是单次请求的防御上限）；等待与总长**只有契约 §7 那两个数**（首字节 30s / 总长 300s），注入位仅存在于 `ModelGateway` 构造函数供单测压到毫秒级，`keel run` 与 `buildRuntime` 都没有对应参数（留一个没人能按的开关就是债）。舱→宿主那三笔 op 的请求超时取 300s 档，内核侧单次等待取 30s 档——于是正常路径内核一定先答（截断页），通道超时只在真故障时命中。
3. **会话查找失败复用 `SCHED/NOT-FOUND`**（`detail.reason:"STREAM_NOT_FOUND"`），且**不区分**"这个 streamId 不存在"与"这个 streamId 不是你的"：区分就是给跨 run 探测留一条信道，而 `streamId` 只是标识符不是权限（决策 1 的归属条款）。
4. **同 reqId 重放对已终会话返回既有终页 + `replay:true`**（决策 5），与 `model.invoke` 的"失败不缓存、可重试"有意不同：流式的失败已经付过分片钱，账上有一条 `truncated` 用量，重放终页比再打一次上游更诚实。要重来就用新的 reqId。
5. **基准行已落**：`keel bench` 加了 B5a（网关侧首页/全流，含 settle+落账）与 B5b（真舱通道取完同一条流），只测量不设阈值；数据入 Phase 1 报告的 A8 段（切片⑥用真样本复采）。
6. **通道层的一个缺陷由这条路径暴露**：`toFrameError` 原先只对 `ChannelError` 保 `detail`，Core 侧的 `KeelError` 跨通道后只剩一个光码——B7④ 要求"失败前给了几片、结了多少钱"能穿回舱内，故修在序列化层（形状不变，仍是 `{code, message, detail?}`）。真进程测试是唯一能看见这层的观测位，单测全绿也照样漏。
