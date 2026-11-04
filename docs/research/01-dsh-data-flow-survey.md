# Research 01：DeepSeek Harness 关键数据流勘察

- 状态：冻结（事实与数据；checkout `8bd073392e`，2026-11-03 快照——DSH 处于 developer preview，结论按形状读，行号是快照证据非锁定引用）
- 日期：2026-11-04
- 来源：对 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）三个只读勘察任务（模型流 / 会话上下文流 / 桌面流）；本文件只沉淀 **DSH 侧事实**，Keel 侧映射方向与设计稿必答问题见 [phase-4 合同 §6](../roadmap/phase-4-profile-engine-loop.md)
- 用途：Phase 4 及后续阶段设计稿的参照目标（"每一步都有参照，防止跑偏"）

## 1. 架构事实基线

- pnpm monorepo：`packages/` 约 384 包（53 个组）+ `apps/` 5 个 + `vendor/` 9 个（Cordis 内核及其配套，重 scope 为 `@deepseek-ai/*`，本地修改 V1~V28 逐一登记于 `vendor/README.md`）。
- 插件单位 = Cordis 插件：带 `name` / `inject` / `apply(ctx)` 的对象；Context 是服务仓库（约 150 个稳定 `ctx.<key>`）；依赖即 `inject` 数组；通信 = service 调用 + 类型化事件（五种派发模式，waterfall 即 around 中间件）；所有注册是可逆 effect。
- 装配 = bundle（`package.json.dsh.bundle.patch` 指向 `cordis.patch.yml` 行清单）→ profile（命名组合）→ home patch → `--patch` 覆盖；`dsh --profile web --dump-config` 可打印整棵装配树。
- 成长顺序（git 前 60 commit）：vendor 内核 → seam 接口包 → agent-loop 插件 → echo 示例 → bash 三件套 → 两个 LLM 适配器 → session 持久化（JSONL + 第二后端）→ ACP/SDK → 客户端 UI 大军（约 60 插件）→ 市场/安装器。

## 2. 六条最重要的流级结论

1. **进程边界画在 durable 事件日志上，不画在实时 delta 管道上。** 四个跨进程 subagent 后端（dsh-sdk / acp / codex / claude-code）没有任何活的 token-delta 通道跨进程；跨界的是已落账 session 事件复本（dsh-sdk：每条 durable 事件原样发成 `session.event` 通知，`sdk/server/src/server.ts:164-172`）或私有协议终态文本；决策只消费结算后消息（`subagent/src/out-of-process.ts` 通用契约：结果永不 reject、取消本地先行结算保部分输出、teardown 阶梯 shutdown 1s → stdin EOF 6s → SIGTERM→SIGKILL 3s、不支持的能力零启动即拒绝）。
2. **计量不是旁路：usage 是流内事件，计量是日志的投影。** token-meter 折叠 durable session 事件而非实时流，无独立 meter 存储（`token-meter/src/usage-projection.ts:81-85`）；usage 由适配器报告、随 `assistant/message` 落账。
3. **模型上下文 100% 是日志表面投影；请求是日志的纯函数；压缩是视图操作。** `deriveMessages()` 无滑动窗口全量投影；压缩用 `surfaceOp: replace` 遮蔽旧节点，原始事件永留，模型视图与人读 transcript 分离（`session/src/surface.ts:79-93`）。
4. **下行治理范式四件套：ready 先行 + 显式白名单 + 整体投递/整体丢弃 + Host 计算整值投影。** 转发事件常量白名单（`remotes/src/remote-events.ts:27-59`）；投递点按资源裁决，"payload 永不裁剪"（`gateway/src/index.ts:615-637`）；客户端投影存储零域折叠（`projection-store.ts:1-13`）；waterfall 应答权 owner-only（`gateway/src/index.ts:584`）。
5. **挂起交互的持久状态只有投影与日志。** ask_user 答案双路径：调用开着 → waterfall 原路返回恢复挂起工具；已 pending/进程退出 → answer RPC 变新 user turn 不复活工具；timed 超时返回 `{"pending":true}`（"超时不是批准"）；pending waterfall 对新 owner 流重投（断线可续答）。
6. **UI 插件无进程级隔离。** 约 60 个客户端插件与壳跑在同一 JS 上下文（无 iframe/worker，`docs/subsystems/client-modules.md:11,94`）；隔离 = 编译期插槽声明（渲染未声明槽即激活失败）+ 每 entry React ErrorBoundary + 监听器 try-catch；组件只拿五个 props share、摸不到 ctx。

## 3. Flow B：模型流实况

- **seam**：`ctx.llm.stream(options): AsyncIterable<StreamChunk>` 单方法事件流（7 种 chunk：block-start/end、text/reasoning/tool-call delta、usage、finish）；适配器 throw 归一为终结 chunk，消费者自身抛错保持 throw；横切面（重试/标题/checkpoint）全挂 `llm/stream` waterfall 不改 loop；`prepareCall()` 冻结 config 并限 stream 单次 dispatch（防能力解析代与请求代错位）。
- **密钥**：直连 fetch + SSE；**每请求**当场 `resolveAuth`；配置只存引用名（env var 名）、每操作重解析禁止缓存、配置面 presence-only、错误诊断 ref-only 绝不回显；子进程环境剥除 `/KEY|PASSWORD|SECRET|TOKEN/i` 与自家变量，密钥进子进程须显式声明；密钥全程不进事件/日志/UI。
- **消费**：调模型点唯一（loop step）；每 chunk 三件事——游程压缩进累积器（`AssistantStreamRecord`）、BlockAssembler 按 index 拼块（工具参数从 delta 逐段拼接）、发实时帧；终结结算 `assistant/message {message, usage, stream}`；请求 = 日志投影纯函数 + 深冻结。
- **失败**：重试归适配器注册的 provider policy，只重试 `retryableCodes` ∩ maxRetries，重试本身 durable（先落事件再等待）；流中途失败三收束形态——abort 且有前缀 → `assistant/message{interrupted:true}`；其他异常 → `assistant/attempt`（完整压缩流）；finish(error) → waterfall 重试或抛错。**已发部分永不悬空**；取消经融合 AbortSignal 传播，适配器主动拆 socket。
- **超时**：模型调用**无总超时治理**（guard/timeout-policy 只包工具），唯一防线是适配器内 idle watchdog（默认 300s，按 chunk 到达 rearm）。
- **web 拓扑**：单 Node 进程（webserver+gateway+loop+适配器+meter 同进程）；浏览器收**原始 chunk 帧**；唯一显式流控 = gateway 上行缓冲 256KiB 上限。

## 4. Flow C：会话与上下文流实况

- **纯 event-sourcing**：Session = append-only 日志，`seq = log.length` 三处强制连续；核心 14 类事件 + 插件 declaration-merge 扩展（全量 63 类）；信封含条件性 `surfaceOp` / `sourceEventSeqs`；写权开放但三重门（store 挂载+公告、lossless JSON、表面元数据校验）；插件记录走独立通道强制 `ignorable` 且不可带 surfaceOp（防借日志污染模型视图）。
- **持久化**：`append` best-effort（200ms write-behind 批量 + fsync）、**`flush` 才是承诺**；三个语义检查点 fail-closed（模型 dispatch 前 / 顶层工具 dispatch 前 / pre-step 前，"未落盘就不发请求"）；崩溃双修复（物理 torn-tail 截断重写 + 语义 open-turn 合成闭合事件）；单写者 = 进程内 tracker + 跨进程内核锁；resume = 抢写锁 → 全量读 → 修补 → seed。
- **上下文装配**：进模型的只有表面投影消息（全量）+ 本步工具集（走 `request/header.tools` 独立通道）+ config；系统提示是受 `system/message` 事件（node 0 专属保护）；动态运行时快照 `user/message` 仅变化时追加；header/toolHistory 增量 fold O(新事件)。
- **压缩 = 视图**：`compaction/start`（durable 锁）→ 摘要（复用 KV cache 前缀）→ `compaction/summary`（含 shadowedSeqs）→ replace 版 `user/message` → `compaction/end`，失败留痕；触发四路（压力/换模型/overflow 恢复/手动）；tool-result 裁剪只许改 content；image offload 纯投影。
- **分区（三层）**：session 独立日志（fork 继承前缀 + tagged marker）；scope 键路由事件**只向上流永不向下**；注册表分层（agent 作用域 shadow 全局、restrict 仅 agent 可发起、继承工具过每层 restriction 相交过滤）；无跨会话共享可变记忆，投影状态按 `WeakMap<Session>` 分键；subagent 谱系（parentSession/delegationDepth）持久化进 header——委托深度跨 resume 不重置。
- **投影基建**：纯 fold + 水位 + 变更 feed，unit 同步/纯/plain JSON；投影缓存**永不领先日志**（写前先 flush），身份不匹配整行丢弃重 fold。
- **checkpoint 三义无回滚**：持久化 flush 屏障 / 压缩上下文快照（resume aid）/ 投影缓存行（永不权威）；回滚替代物 = fork（任意 seq 开子会话 + 合成 closers）。
- **外围通道**：title 走 log-only 事件（永不进模型表面）；cwd 进 header（事件日志之外）；agentPreset/delegationDepth/origin/isSeeded 全在 header 且各有持久化理由注释。

## 5. Flow D：桌面流实况

- **传输与身份**：unary RPC = HTTP POST（统一 ok/error envelope）；流 = 单条 WebSocket mux `/api/remote.mux`（帧 open/item/end/cancel | item/error/end，streamId，心跳，上行 256KiB 上限）；启动令牌换签名 authority Cookie；信任链（loopback/bind IP/Origin 同 authority/跨站 403）；一 socket 一 Peer（principal + interactions，answer 才能参与瀑布）。
- **下行三通道**：① durable 日志 follow（opening 快照帧 → 带显式 seq 的增量，客户端强制 seq 连续性校验，缺号即协议错误；交付原始事件，客户端只做包络验收）；② 控制/投影流（Host 算好整值，非 owner 逐条过滤）；③ 白名单转发事件（常量唯一允许集；整条送达或整条丢弃 payload 永不裁剪）。**ready 先行是协议铁律**（先挂全部增量监听再发首帧，之后才允许 baseline 读取）。
- **客户端应用**：事件消费是普通客户端插件；Session 窗口变化仅四种 delta（replace/prepend/append/settle-assistant）；瞬态 `assistant/live-chunk` 行按 seq 插在持久行之间、durable 结算时原子替换；渲染节流三档（手势同步/微任务批/按帧合并）。
- **上行动作**：可调面 = `@Remote` 编译面 ∩ remote-access 策略面；owner 永不检查；一调用的所有资源必须全被允许；裁决先于 Agent 激活；拒绝是结构化 RemoteError；**敏感操作不走访问控制走独立 approval waterfall**（无应答器 fail-closed；`approval/asked`/`decided` 审计事件对模型不可见；授权仅一次性）。
- **ui 插件**：一特性一包，`slots.register(声明, 组件)`，重复/未声明槽激活期失败；聊天节点 = ConversationNodeDefinition（match 只读事件、update 按 seq 确定性可重放、delta 需双分支）；跨插件仅 `import type` + 服务注入 + slot，禁止互 import。
- **ask_user 端到端**：`ask()`（阻塞）/ `askTimed()` → agent-scoped waterfall（身份校验：须为 registry 里 live root agent，subagent origin 拒绝）→ owner Peer 帧投递 → 卡片渲染 → 双路径回流（见 §2.5）；投影是唯一持久状态（不存 wait/focus/deadline）；审批是同一瀑布生命周期的镜像实现。
- **桌面三进程**：Electron 主进程 = 最薄壳（协议处理器转发 + Origin/cookie 校验）；desktop-host = RunAsNode 子进程跑 dsh CLI（Host 本体）；渲染进程 = 同一 Web 应用、无桌面专属业务协议；boot 注入一次性（插件图 + 访问快照全局行）；cookie 只在主进程内存。
- **断线重连**：物理层代际递增 + 抖动退避；逻辑层每流与代对齐、consumer 须确认 baseline；**恢复语义按数据类型分派、无全局 resync**——durable 日志 = 新快照原子替换（光标校验）；控制/投影 = 保旧值换 baseline；普通通知 = 不重放；挂起交互 = 重投；投影缓存重连即清、从 asOfSeq 一致切重播种。

## 6. Flow A/E 对照补记

- **A（工具调用生命周期）**：DSH 治理 = waterfall 监听器挂每条流（pre-execute → execute → post-execute → result）+ per-tool timeout-policy（只包工具）+ subprocess seam（env 擦除/受限输出/进程组 kill 升级）；`tool/call`+`tool/result` 带 `sourceEventSeqs` 溯源。全库无补偿（compensation/undo）概念——越界副作用治理在 DSH 是缺位项（Keel 补偿语义是差异点，保留不动）。
- **E（故障/故障半径）**：Cordis observer 级包含 + effect 回卷（框架级、同进程）+ 子进程 kill 阶梯 + "已收事件不丢、本地先行结算"；子进程死亡 → 父进程压平为 `error` + 安全化诊断（≤4096 字节、不读 stderr 原文）。

## 7. 与 Keel 不变量的逐条对照（事实侧）

| Keel 不变量       | DSH 对应事实                                                                                   | 差距性质                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| I1 控制不可旁路   | 连 agent loop/工具注册表都是可整行替换的插件；治理=代码内 waterfall                            | **根本差异**，Keel 不学；可借鉴的是"横切面靠拦截带不靠改 loop"的形状 |
| I2 故障不可级联   | 同进程服务图 + observer 级 try/catch；进程隔离只在 subagent/桌面/SDK 四处                      | Keel Cell 全量物理隔离，严于 DSH                                     |
| I3 状态不可丢失   | 五件套：append-only 唯一事实 + 语义检查点 + torn-tail 修复 + open-turn 修复 + 缓存永不领先日志 | 可整体借鉴形状                                                       |
| I4 副作用不可无痕 | **无补偿概念**；越界副作用治理缺位                                                             | Keel 独有，无参照                                                    |
| I5 上下文分区     | 五类表面事件投影 + scope 只向上流 + 注册表分层 + WeakMap 分键 + 只读 sessionQuery              | 形状高度可借鉴                                                       |

## 8. DSH 的两条"没做好"（Keel 必须自己设计）

1. **模型调用无总超时/预算治理**（只有适配器内 idle watchdog）——Keel 预算不变量要求整调用预算语义，需自建。
2. **UI 插件零进程隔离**（同上下文 + ErrorBoundary）——Keel 渲染沙箱级隔离是原创设计点，无参照、风险单列。
