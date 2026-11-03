# Phase 2 切片⑤：契约修订与三项回填

- 状态：**草案**（2026-11-03 起草；§7 四项待所有者确认后转定稿——定稿前不写实现代码，铁律 1）
- 日期：2026-11-03
- 关联：[phase-2 合同](../../roadmap/phase-2-cordis-compat.md) §7 切片⑤（锚 **B7②③④⑤ + B8**）、§2「做」的回填项 ②③④ 与「契约修订随 ADR-0008 落地」、§6 风险 5；[ADR-0008](../../adr/ADR-0008-decision-attribution-upper-bound.md)（决策 1~5，落点就是本片）；[契约](../phase-1/01-core-api-contract.md) §4.1 / §4.5 / §4.7 / §5 / §6 / §7 / §12；[ADR-0003](../../adr/ADR-0003-model-gateway.md)、[ADR-0004](../../adr/ADR-0004-ledger-consistency-point.md)、[ADR-0005](../../adr/ADR-0005-cell-isolation.md)；[Phase 1 报告](../phase-1/report.md) §3 限制 2 与限制 4；[06 稿](06-policy-chain-and-d-tier-refusal.md) §9（两条限制由本片接手）；[05 手册](05-migration-handbook.md)

## 1. 这份文档回答什么

一句话问题：**Phase 1 收官时挂着的四条"主张比实现多一寸"的地方，各自的确切行为是什么，改完之后账本上还留不留得住旧账本？**

四条主张（每条的可断言落点见 §4）：

1. **B7⑤（throughSeq）**：`DECISION` 除 `basedOn` 的关键引用外，还显式写出**本决策的信息上界**（该 run 此前已写入的最大事件编号）；任何直写事件（授权拒绝、预算、效果、快照引用）都自动落在上界之内，不再出现"这条确实发生过却不在任何依据列表里"。同时 **Phase 1 的旧账本样例仍然可读**。
2. **B7②（快照持久化）**：宿主进程重启后，凭账本里的 `STATE_SNAPSHOT_REF` 能把快照取回来并挂载——这条今天**做不到且失败得很安静**（见 F4）。
3. **B7③（drain 语义）**：一个 Cell 的收尾有确定次序（不再接新动作 → 在途动作收束 → 退出），且"收尾期仍被在途 run 使用"这种局面有明确裁决而不是巧合。
4. **B7④（流式通道）**：`model.stream` 落地，且**记账时序不变式一条不松**（授权一次、预扣一次、无 settle 不算完成）。

> 为什么这四条一起切：它们都不新增生态面（不动承接层的映射表、不动权限词表的语义），改的都是内核与宿主的**承诺口径**；而 B8 要的"不退化"正好要靠这一片把 Phase 1 报告 §3 挂的两条限制关掉，否则阶段验收报告里那两条限制会一路带到 tag。

## 2. 开工前的事实核对（十四条，源文件可核）

| #   | 事实                                                                                                                                                                                                                                                                     | 后果与本片处置                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `DecisionPayload = {round, summary, basedOn}`（`core/src/events.ts` 105-110）；全仓 `throughSeq` **零命中**                                                                                                                                                              | ADR-0008 决策 2 是纯待办；本片是它的落地点                                                                                                                                                                                                                       |
| F2  | `basedOn` 的来源是 `h.events`（`scheduler.ts` 120「本 run 已写事件 seq」）+ `emit()` 每次把**自己写的** seq 推进去（`scheduler.ts` 528-532）                                                                                                                             | 直写事件不入依据集：`AUTH_DENIED`（`authorizer.ts` 62）、`BUDGET_*`（`budget.ts` 122/151）、`MODEL_*`（`gateway.ts` 95/113）、`EFFECT_*`/`COMPENSATION_*`（host）、`STATE_SNAPSHOT_REF`（`apps/keel/src/runtime.ts` 234）——正是 ADR-0008 背景段那批              |
| F3  | 账本 seq 由 `makeEvent` 在**写队列执行期**分配（`ledger.ts` 117 注释 + 141-149），不是调用时分配                                                                                                                                                                         | 于是"调用方先读一下当前最大 seq 再拼进载荷"会漏掉读与写之间落账的直写事件——**恰恰是 ADR-0008 要修的那类错**。字段必须由账本在写入点盖章（§3.1 第 2 步）                                                                                                          |
| F4  | 快照是两块内存 Map（`host/src/snapshot.ts` 18-41）；`runtime.ts` 195 每次 `new SnapshotStore()`；`cmd-recover.ts` 55 在同一 `dataDir` 重开 runtime                                                                                                                       | 跨进程恢复时账本读得到 `STATE_SNAPSHOT_REF`、存储里必然没有 → `recovery.ts` 100-109 抛 `RECOVER/SNAPSHOT-MISSING`。**即今天 `keel recover` 跑在"曾 checkpoint 过的 run"上是注定失败的**，且失败点离原因很远（静态可证；施工第 1 步先写真子进程复现测试，铁律 7） |
| F5  | ref 形状 = `<agentId>\|<sessionId>/snap-<version>`（`snapshot.ts` 5-32 约定）                                                                                                                                                                                            | `\|` 在 Windows 是非法文件名字符 → 落盘**不能拿 ref 当路径**；ref 是标识符，路径另派生（§3.2 第 1 步）。账本里已存的 ref 字符串一行不改（旧账本可读）                                                                                                            |
| F6  | `Ledger.writer()` 冷启动时 `lastSeq` 从 0 起，且已有"冷实例扫文件"的先例（`lastCheckpoint` → `scanCheckpoint`，`ledger.ts` 143-152）                                                                                                                                     | 快照存储也需要冷启动恢复版本号，否则重启后 `save()` 会从头计数、把新内容写进旧版本号上（覆盖历史快照 = 归因污染）                                                                                                                                                |
| F7  | `drainAndReap()` = `halting` → `kill()` → `reaped`（`supervisor.ts` 249-253），**不等任何东西、没有在途计数**；`executor` 只挡 `exitResult`（`supervisor.ts` 191-197）                                                                                                   | 收尾期在途动作现在是"被 kill 打断 → 通道断 → error 结果 + 效果落 unknown"。这不是 bug 而是**没定义**；B7③ 要的是确定次序与可断言的产物（§3.3）                                                                                                                   |
| F8  | `hotSwap` 换绑后**不 dispose 旧舱**，`assembly-manager.ts` 104 行注释写明"旧 Cell 的收束由调用方在其 run 结束后 dispose"，`assembly-manager.test.ts` 104 断言 `disposed === false`                                                                                       | 与 F9 合起来看：换绑时旧舱仍被在途 run 使用，谁提前 drain 谁打断那个 run。本片把这条**写成规则而不是注释**                                                                                                                                                       |
| F9  | `executor: cell.executor` 在 `scheduler.start` 时**逐 run 捕获**（`runtime.ts` 351-354）                                                                                                                                                                                 | 换绑不会改变已在途 run 的调用目标——"升级从下一轮生效"这条 B6 主张今天靠的是这个巧合。§3.3 第 4 步把它钉成断言                                                                                                                                                    |
| F10 | 契约 §4.7 已有 `model.stream` 这一行（流式透传、用量以流结束时机网关计量为准、连接 300s/首字节 30s、**不重放**）；§7 已给三档时限；§12 把"背压与断流恢复语义"列为待决                                                                                                    | **时限数不用新增**（§7 既有三条就是预算）；本片真正要定的是**通道形状**，因为它撞到 F11                                                                                                                                                                          |
| F11 | 帧协议是**一请求一响应**：`respond()` 每次请求写一帧（`protocol.ts` 158-181），`handleLine` 收到首条同 id 响应即 resolve 并从 pending 删除、**迟到帧丢弃**（`protocol.ts` 211-224）；`EventFrame`/`onEvent` 双侧能收，但**全仓没有任何事件帧发送方**（grep 零 producer） | 推式流式要同时新增：发送面、分片-请求关联、迟到/乱序处理，并作废"单请求单响应"这条被 supervisor 三处超时依赖的不变式（`supervisor.ts` 199-208）。拉式不需要（§3.4 的取舍根据）                                                                                   |
| F12 | 权限词表是封闭枚举（`schema/keel-plugin.schema.json` 的 `permissions.cap`：`tool.provide`/`model.adapter`/`net.fetch`/`fs.read`/`fs.write`/`memory.backend`），`model.adapter` 现在只编译出**一条** `model.invoke` 规则（`permission-rules.ts` 18-24）                   | 流式要不要新开一个 cap？新开 = 报关单字段扩展（manifest 稿 §5.2 明文"词表新增须 ADR"）。§3.4 第 1 步按**不新开**处理：一个能力两项动作                                                                                                                           |
| F13 | 承接层对 `ctx.llm` 只挂了 `chat` 一个拒面（`cordis-adapter/src/core.ts` 375-378）；未知成员（如 `ctx.llm.chatStream`）拿到 `undefined` → 裸 `TypeError`，**没有改法去处**                                                                                                | 这是"静默"的一种形状（不是降级，是没有交代）。本片给它一个护栏（§3.4 第 5 步），**不改档位、不放行旧面**                                                                                                                                                         |
| F14 | `SCHEMA_VERSION = 1` 是**全局一枚常量**，每条事件都盖（`events.ts` 22 + `ledger.ts` 311），且**没有任何读方按它分支**；切片④给 `ASSEMBLY_RECORDED` 追加 `policies` 时它仍是 1（`events.ts` 95-99 注记「追加字段：缺省不写」）                                            | ADR-0008 决策 4 说"信封 schemaVersion 递增"——但按今天的全局写法，递增等于宣告**所有**事件类型都变了（不真实），并且反证切片④那次追加没处盖章。递增位置是 §7 第 1 项                                                                                              |

## 3. 方案

### 3.1 B7⑤：`DECISION.throughSeq`（四步）

1. **语义写死为"写入点之前该 run 已存在的最大 seq"**（ADR-0008 决策 2 的字面），并同步 `basedOn` 的注释口径为"本决策显式引用的关键事件"（决策 1）。二者合起来的归因表述：依据 = `basedOn` 关键引用，信息上界 = `throughSeq` 之前的全部账本内容。
2. **由账本在写入点盖章**，不由调度器自报（F3 是这条的技术理由）。形状：`Ledger.append(ref, type, payload, opts?: { stampSeqBeforeAs?: string })`——调用方声明"把写入前的高水位写进载荷的这个键"，账本保持在类型无关（它今天也只自己写 CHECKPOINT 一类）。`scheduler.ts` 的 DECISION 一处传入 `"throughSeq"`。
3. **不枚举**（决策 3）：`basedOn` 不扩成 `[1..lastSeq]`；账本体积按轮线性而不是平方。
4. **兼容 = 缺字段即"无显式上界"**（决策 4）：读方（`cmd-replay.ts` 32-33、`audit-attribution-replay` 那组断言、`manifest-synthesis` 的读侧）不得因缺字段报错；`keel replay` 的 DECISION 行在有该字段时多打 `throughSeq=N`，无则打 `throughSeq=（旧账本，无显式上界）`——审计员看得见"这是旧账本"而不是"内核没写"。

一条要如实写下的话：**今天 seq 是稠密的（每个 run 单一写者、`lastSeq+1` 递增），所以 `throughSeq` 的值恒等于 `seq-1`，读方本可自己推导。** 字段的实际价值在两处，都不是"新信息"：① 它是**内核亲口声明**的边界，读方不需要再假设稠密；② 稠密性从此有一条**断言**钉着——哪天写入面变了（分片、批量、多写者），`throughSeq === seq-1` 破裂即测试红，而不是让归因悄悄漂移。测试要同时钉住"值 = 写入前高水位"与"等于 seq-1（稠密性哨兵）"两条。

### 3.2 B7②：快照物理持久化（五步）

1. **存储换成落盘实现，ref 约定不动**。`SnapshotStore` 构造函数加 `rootDir`；ref 仍是 `<agentId>|<sessionId>/snap-<version>`（账本已存的值不改，F5）；路径另行派生 `<rootDir>/<agentId>/<sessionId>/snap-<version>.json`。
2. **写序 = 先内容后引用**：`save()` 必须在文件写成功后才返回 `{ref, version}`，宿主再写 `STATE_SNAPSHOT_REF`（今天就是这个调用序，`runtime.ts` 224-236）。于是"账本有 ref 而内容不存在"只可能来自外部破坏，不会由本片自己制造。
3. **原子性 = tmp + rename**（同目录），版本号单调保证 rename 目标不存在。**冷启动恢复版本号**（F6）：构造后首用扫本 scope 目录取最大 `snap-<version>`；与 `scanCheckpoint` 同一姿态（宁可扫一次，不要静默从头计数）。
4. **失败面是可见失败，不新增错误码**：内容不可 JSON 化或写盘失败 → `save()` 抛 → checkpoint 缝抛 → 该 run 走既有失败路径（`RUN_FAILED`）。**不做"跳过这次快照继续跑"**（那是把 D3 的主张换成"多数时候能恢复"）。`RECOVER/SNAPSHOT-MISSING` 保留原语义：ref 在、内容不在 = 外部破坏/目录丢失。
5. **目录从哪来**：`keel run/recover --snapshots <dir>`，缺省 = 由 `--data <dir>` 派生的同级 `<name>-snapshots`（`cmd-observe.ts` 58 已有 `<name>-ledger` 的同款命名先例）。**不改 `dataDir` 的含义**（它一直是账本根，`Ledger.scopeOf`/`cmd-recover.findRunRef` 都在按"根下一层是 agentId"扫描，塞保留子目录会污染那两处扫描）。不新增第三个路径概念。

### 3.3 B7③：旧 Cell drain 的确定行为（四步）

定义 `drainAndReap()` 的完整次序（今天只有 F7 那一行 kill）：

1. **进入 `halting` 即拒绝新动作**：`executor` 收到新 `tool.exec` 直接返回 `{status:"error", error:{code:"SCHED/BACKPRESSURE", message:"cell draining"}}`——`SCHED/BACKPRESSURE` 是契约 §6 既有的**准入类**码（"退避后是"），语义对得上且不动封闭集合。**不新增 `CELL/DRAINING`**。
2. **等在途动作收束**：ManagedCell 记一个在途集合（`tool.exec` / `compensation.exec` / `cell.snapshot` / `policy.hook` 都经同一 executor/conn 计数），drain 先 await 它们。每个在途调用**自带**超时与强杀计时（`toolCallTimeoutMs + toolKillGraceMs`，`supervisor.ts` 199-208），所以这里不引入第四个时限数。
3. **硬界 = `toolKillGraceMs`（既有默认 5s）**：await 带一个宽限期，期满仍在途 → `kill()`。这是给 `closeRuntime` 与 CLI 收束的兜底，保证宿主永远能收摊。同步忙等的插件会卡住事件循环、连这个 timer 也进不来——那是 P-008 记过的既有事实，物理强杀口径与容器后端一起评（backlog，§9 第 3 条）。
4. **收束产物 = `DrainOutcome{inFlightAtStart, refused, settled, waitedMs, killed}`**（返回值，不是账本事件）。**不新增事件类型**：drain 是宿主侧生命周期动作，账本 §5 是封闭集合；"在途动作因收尾而结果未知"这件事已经由既有路径留痕（`settleEffects` 在 error/timeout 时写 `EFFECT_SETTLED{status:"unknown"}`）。
5. **谁在何时 drain（写成规则，不再是注释）**：run 终态之后（`wire-cell.ts` 68、`closeRuntime`、policy-link 收束都是这一类）；`hotSwap` 的旧舱由**其 run 终态后**的调用方 drain——AssemblyManager 不得对在途 run 的旧舱动手（F8+F9：换绑不改在途 run 的目标，提前 drain = 打断那个 run）。这条要落成一个真进程测试：升级发生在 run 中段时，在途 run 照常跑完、旧舱在终态后才收。

### 3.4 B7④：`model.stream` 的通道形状与记账时序

形状取**拉式分片**（§7 第 3 项交所有者确认；选它的理由是 F11——不动"一请求一响应"这条被 supervisor 超时与 fail-stop 依赖的不变式）：

1. **两个新 Cell→Host op + 一个可选收尾 op**：`model.stream.start {reqId, model, params, estimate}` → `{streamId, chunks, done, usage?, cost?}`；`model.stream.next {streamId, limit?}` → `{chunks, done, usage?, cost?}`；`model.stream.cancel {streamId}`。**权限动作**随 `model.adapter` 编译（F12：不新开 cap，一个能力两项动作 `model.invoke` + `model.stream`），报关单字段与 schema **零扩展**。
2. **网关侧新增会话表**（放 `packages/core/src/stream.ts`，避免 `gateway.ts` 从 128 行胀成触线文件）：`reserve` 一次（estimate）→ 上游产出分片入缓冲 → `next` 按消费方节奏出片。背压问题在此**由构造消解**（消费方不取就不产不攒），§12 那条待决的"背压"就此关闭。
3. **记账时序不变式（一条不松，ADR-0003）**：授权一次 → 预扣一次 → `MODEL_INVOKED` 一次（载荷追加 `streamId`）→ **每片不写事件**（否则账本按 token 增长，ADR-0008 决策 3 反对的正是这个）→ 流终了写 `MODEL_USAGE{usage, cost, truncated}` 并 `settle(权威计量)` → 无 settle 不算完成。
4. **断流口径**（§12 待决的另一半）：`next` 超时 = `TRANSPORT/TIMEOUT` = 结果未知（契约 §6 约定）→ 会话标为中断 → **settle 已产出部分的权威计量、退还剩余预扣**，`MODEL_USAGE.truncated:true`，发起方本轮按既有工具/调用失败路径处置（`RUN_FAILED` 或 hook③ 重试建议，不级联其他 Cell）。**不静默全额退还**（那等于宣称这次调用没花钱，而分片已经给出去了），也**不静默丢弃**。
5. **承接层护栏（本片唯一的承接面改动，不改档位）**：`ctx.llm` 的未知成员也走 `ADAPTER/UNSUPPORTED` + 改法去处（F13），去处文案指向 `ctx.model.invoke`。旧流式写法**一条都不放行**——`model.stream` 是内核能力回填，不是旧面的映射目标；真样本暴露出具体旧符号时按 B5 义务补边界表行。
6. **上游适配器**：`ModelUpstream` 加**可选** `stream?()`。未实现流式的上游被请求 `model.stream.start` → 显式失败（复用 `GATEWAY/UPSTREAM-ERROR` + `detail.reason:"UPSTREAM_NO_STREAM"`，不新开码）。MVP 的 CLI 桩上游给一个可控分片实现（测试与基准都要它）。

## 4. 测试面与验收锚点

| 测试                                                       | 内容（断言要点）                                                                                                                                                                 | 锚点               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `packages/core/test/ledger.test.ts`（扩）                  | `stampSeqBeforeAs` 在写队列执行期取值；与并发直写的交错场景下 `throughSeq` 仍 = 前一条事件的 seq；稠密性哨兵 `throughSeq === seq-1`                                              | B7⑤                |
| `packages/core/test/gateway-stream.test.ts`（新）          | 授权/预扣各一次；分片不写事件；`MODEL_USAGE.truncated` 与 `settle` 的部分计量；未实现 stream 的上游被显式拒；同 reqId 二次 start 不重打上游                                      | B7④（记账时序）    |
| `packages/host/test/snapshot-store.test.ts`（新）          | 冷启动版本号接续、tmp+rename 不留残File、不可序列化即抛且不落 ref、按 ref 取回旧进程写入的内容                                                                                   | B7②                |
| `packages/host/test/supervisor-drain.test.ts`（新）        | halting 后接新被拒（`SCHED/BACKPRESSURE`）；在途 await 到收束；超 `toolKillGraceMs` 则 kill；`DrainOutcome` 各字段真实                                                           | B7③                |
| `tests/snapshot-cross-host.test.ts`（新，**先红**）        | 真子进程：进程 A 跑到 ≥1 次 checkpoint 后 kill → 进程 A 退出；**同一 dataDir/snapshots 的新进程** `keel recover` → 快照挂载读到旧状态 → `RUN_RECOVERED`。今天必然红（F4）        | **B7②**            |
| `tests/decision-through-seq.test.ts`（新）                 | 真实 run 里取一条 `AUTH_DENIED`（调度器不写它）：断言它 ≤ 当轮 `throughSeq` 且**不在** `basedOn` 里——即"上界承载它，关键引用不假装承载它"；再读 Phase 1 旧样例断言可读且无该字段 | **B7⑤**、A6 口径   |
| `tests/cell-drain-inflight.test.ts`（新，真进程）          | 升级/收束时机：旧舱在途 run 不被打断（F9 钉死）；run 终态后 drain 的 `DrainOutcome`；drain 期被打断的效果落 `EFFECT_SETTLED{unknown}` 而非无痕                                   | **B7③**、B6 不退化 |
| `tests/model-stream-channel.test.ts`（新，真进程）         | 舱内 `model.stream` 分片顺序与总用量；断流（上游中途抛）后账本恰一条 `MODEL_INVOKED` + 一条 `truncated:true` 的 `MODEL_USAGE` + 一次 settle；其他 Cell 不受影响                  | **B7④**            |
| `tests/cordis-adapter-tier-a.test.ts` / 符号扫描（扩各 1） | `ctx.llm.chatStream` 命中 `ADAPTER/UNSUPPORTED` 而非 `TypeError`；边界表符号归属不退化                                                                                           | B5 增量、F13       |
| `apps/keel/test/cli.test.ts`（扩）                         | `--snapshots` 生效与缺省派生；`keel replay` 对新账本打 `throughSeq=`、对旧样例打"无显式上界"                                                                                     | 交付入口           |
| 既有 A1~A8 / 契约级五测试点 / 切片①②③④验收组               | 不动，按 B8 复跑（合同 §6 风险 5 的守门就是这条）                                                                                                                                | B8                 |

## 5. 与前四片的接缝（不重做）

- 切片①的注册通道、切片②的装载门与 `wireCell` 就绪探测、切片③的三个改法面、切片④的策略舱与 `policy.hook` **都不改语义**；本片只在 supervisor 的收尾次序上给它们一个共同的收束定义。
- 切片④ §9 第 1 条（"策略舱后续没被调用时崩溃不进账本"）与第 4 条（"策略舱没有工具时限，忙等兜底只有 200ms 超时 + 人工回收"）里那句"人工回收"，本片由 §3.3 第 3 步的硬界接走——**策略舱同样走 drain 的确定次序**，不另立第二套收尾。
- 切片④给 `ASSEMBLY_RECORDED` 追加 `policies` 时留下的版本问题（F14），本片在 §7 第 1 项一并处置；两处扩展（`policies`、`throughSeq`/`truncated`）用同一口径，不各说各话。
- `throughSeq` 不需要 `policies` 那样的"缺省不写"取舍吗？需要，且同样选**缺省不写**：只有 DECISION 载荷多一个整数，其余事件形状与 Phase 1 样例逐字节一致。
- 05 手册新增一节（流式通道的去处 + 快照持久化后"重启可恢复"的正确用法），`01 稿` 的 #6 行补一条实现期注记（`model.stream` 落地不等于 `ctx.llm.chat` 有流式映射）。

## 6. 体量、依赖与门禁影响

- 代码增量预估（均离 600 行红线很远）：`core`（events 注释 + ledger 盖章选项 + scheduler 一处 + `stream.ts` 新文件）约 +120，`gateway.ts` 保持 130~150；`host`（`snapshot.ts` 41 → 约 120、`supervisor.ts` 284 → 约 330、`cell-server.ts` 194 → 约 230）约 +160；`cordis-adapter` 约 +15；`apps/keel`（两个 CLI 参数 + runtime 构造快照存储 + replay 显示）约 +50。**新增三方依赖 0**。
- 契约与协议：**不新增错误码、不新增时限数**（§3.3/§3.4 的码与时限全部取既有）；新增 **2~3 个 Cell→Host op**（`model.stream.start/next/cancel`）与 **3 个载荷追加字段**（`DECISION.throughSeq`、`MODEL_INVOKED.streamId`、`MODEL_USAGE.truncated`）+ 信封版本口径（§7 第 1 项）→ 属接口决策，**立 ADR-0013**（流式通道形状与记账时序；把推式方案作为被否项留在文内）。`throughSeq` 本身沿用 ADR-0008，不再立 ADR，只在施工后追加**实施注记**（递增位置、盖章点两件事实，决策 1~5 不改）。
- 测试增量预估：约 25~30 条，其中 4 份新集成/单测文件 + 3 份既有文件扩写。真子进程文件 +2（跨宿主恢复、drain 在途）——按 P-006/P-008 的先写时序假设与终态断言。
- 文档：本稿 + ADR-0013 + ADR-0008 实施注记 + 契约 §4.1/§4.7/§5/§12 注记 + Phase 1 报告 §3 限制 2/4 的关闭注记（正文保留，与限制 3 同样的追加式处置）+ 01 稿一行 + 05 手册一节 + docs/README 登记。docs 总篇数 41 → 42（软上限 150，无压力）。
- **B8 的另一半是基准**：`keel bench` 加一行流式口径（首片延迟 / 分片数 / 单 run 总延迟），与承接层开销一起复采；数据写进 `report.md`，**只测量不设阈值**（合同 §2「不做」第 6 条）。§7 的四个"不新增"合起来就是风险 5（新增事件写入源冲击归因）的正面回答：本片新增 **0 个事件类型、0 个写入者**。

## 7. 待所有者确认的四项（各附建议）

1. **信封 `schemaVersion` 的递增位置**（F14；ADR-0008 决策 4 说"递增"，但今天是一枚全局常量且无人读它）
   - **建议：改类型级版本表**（`EVENT_SCHEMA_VERSION: Record<EventType, number>`，`DECISION`/`MODEL_INVOKED`/`MODEL_USAGE` 因载荷追加升到 2，其余保持 1；写点在 `ledger.ts` 一处）。真实表达"只有这几类变了"，并给切片④那次 `policies` 追加补上可对齐的口径。ADR-0008 决策 4 不动，"递增"落在类型级作为**实施注记**补正。
   - 被否 A：**全局 1→2**——字面照做，代价是宣告所有事件类型都改过格式（不真实），审计侧会去找根本不存在的迁移需求。
   - 被否 B：**不递增**，只靠"缺字段即无显式上界"的容忍——最省，但读方永远分不出"旧账本没这字段"与"新内核漏写这字段"，而 B7⑤ 的主张恰好在乎这个区分。
2. **快照落盘的目录与默认**（§3.2 第 5 步）
   - **建议：`--snapshots <dir>`，缺省由 `--data <dir>` 派生同级 `<name>-snapshots`**；不改变 `dataDir` 含义、不加第三个路径概念。
   - 被否 A：**塞进 `dataDir` 的保留子目录**——少一个参数，但污染 `Ledger.scopeOf` 与 `cmd-recover.findRunRef` 两处"根下即 agentId"的扫描，除非两处都加排除逻辑（改动面更大且埋着误匹配）。
   - 被否 B：**只在显式给目录时落盘，否则维持内存**——默认行为零变化，但同一能力两种后端 = 两条代码路径都要测，且"主张默认不成立"（B7② 的表述要打折）。
3. **`model.stream` 的通道形状**（F11，§3.4）
   - **建议：拉式分片（`start`/`next`/`cancel`），并立 ADR-0013**。不动"一请求一响应"，背压与断流由构造消解，超时全部沿用 §7 既有三档；代价 = 分片经多次往返（本地 stdio，数量级亚毫秒），且"流式透传"是**形状上的重新解释**（契约 §4.7 要写修订注记，不是照字面实现）。
   - 被否 A：**推式事件帧**（分片走 `EventFrame` + 末帧响应）——最贴合"透传"字面，但要新开事件帧发送面、分片-请求关联、迟到帧处理，并作废 supervisor 三处超时依赖的不变式；改动半径大到不像一个回填片。
   - 被否 B：**推给 Phase 3**——合同 §2「做」第 4 条是所有者已确认的回填项，推后属范围变更，需要显式签字并改合同与看板表述。
4. **drain 的拒绝码与等待界**（§3.3）
   - **建议：接新用既有 `SCHED/BACKPRESSURE`，等待界 = 在途调用自带超时 + `toolKillGraceMs` 硬界；不新增码、不新增时限数、不新增事件类型**（收尾产物走返回值）。
   - 被否 A：**新增 `CELL/DRAINING`**——语义更醒目，但契约 §6 是封闭表，加码要走 ADR/注记，收益不值一次契约变更。
   - 被否 B：**不记在途集合，维持今天"直接 kill"**——最小改动，但 B7③ 的要求就是"有确定行为"，kill 打断在途动作后只剩 `EFFECT_*` 的 unknown 猜测，等于把主张降级为现象描述。

## 8. 定稿后的落地清单（按序）

- [ ] **第 1 步 = 复现测试先行**（铁律 7）：`tests/snapshot-cross-host.test.ts` 真子进程跑出今天必然命中的 `RECOVER/SNAPSHOT-MISSING`，并留红证据（这条红先于实现存在，才证得了实现满足主张）
- [ ] ADR-0013（流式通道形状、会话与记账时序不变式、断流口径；被否方案留在文内）
- [ ] `core`：类型级版本表（或按 §7 第 1 项所选）+ `Ledger` 盖章选项 + `DECISION.throughSeq` + `stream.ts` 会话表 + `model.stream` 三 op 的服务端处理
- [ ] `host`：`snapshot.ts` 落盘 + `supervisor.ts` drain 次序与 `DrainOutcome` + `cell-server.ts` 流式 op 接线 + `assembly-manager.ts` 注释升级为规则（配套 `assembly-manager.test.ts` 断言随之改写理由）
- [ ] `cordis-adapter`：`ctx.llm` 未知成员护栏（+ 符号扫描一条判据）
- [ ] `apps/keel`：`--snapshots` 参数与默认派生、`keel replay` 的 `throughSeq` 显示、`keel bench` 流式一行
- [ ] 测试：§4 表逐份（§4 的三份真进程文件先红后绿）
- [ ] 文档收口：契约 §4.1/§4.7/§5/§12 注记 + ADR-0008 实施注记 + Phase 1 报告 §3 限制 2/4 关闭注记 + 01 稿 #6 注记 + 05 手册新增两节 + docs/README 登记 + CHANGELOG
- [ ] B7②③④⑤ 验收 + B8 复跑（含 Phase 1 契约级五测试点与切片①②③④验收组）+ 基准复采数据入 report + 体量核对 + 六道门禁（`pnpm clean` 起，逐条取真实退出码）

## 9. 本片的限制（先登记，别等报告）

1. **`throughSeq` 今天是可推导的**（seq 稠密）。它的价值在内核显式声明与稠密性哨兵，不在新信息——评审时别把它读成"补了一批漏掉的事件"。真要不要逐笔精确引用（合规逐笔取证），ADR-0008 的重评条件已经写了。
2. **快照内容必须是 JSON 可序列化的**：`undefined`/函数/循环引用一律拒（拒 = 可见失败，不是跳过）。这给旧插件的 `snapshot()` 面加了一条隐含约束，要写进 05 手册；不做结构化克隆的私有编码格式（那是新格式决策，Phase 3）。
3. **同步忙等仍然只能靠 OS 级强杀**：§3.3 第 3 步的硬界是事件循环里的 timer，插件占死循环时进不来。与容器/microVM 后端一起评（backlog，ADR-0002/0005 的触发条件）。
4. **拉式流式不是"透传"的字面实现**：分片经宿主-舱多次往返，上游边产边被缓冲。契约 §4.7 要写清这个重新解释；若将来出现"必须真流式低首片延迟"的真实需求，重评推式方案（ADR-0013 的重评条件）。
5. **断流的部分计量单位是"网关权威计量"**，不是分片计数——上游若不报中途用量，本片按已下发分片的估算计量并记 `truncated:true`（估算与权威的差额口径要在 ADR-0013 写死，别留给读方猜）。
6. **材料仍是合成**：流式与快照的样本都是我们自己写的形状；真样本到位后按 01 稿 §5 义务回填，B1/B5 第二批复跑（切片⑥）。
