# Phase 2 切片①：承接层骨架与 A 档合成样本

- 状态：**定稿**（2026-11-03 所有者确认 §10 三项，全部按建议落地：授权 ADR-0010 / 边界表两条补注 / 样本组 9 枚 + 新增行 #15 归 C 档；定稿后开始写本片实现代码——铁律 1）
- 日期：2026-11-03
- 关联：[phase-2 合同](../../roadmap/phase-2-cordis-compat.md) §7 切片①（锚 **B1**、B5 部分）；[01 稿 迁移边界](01-cordis-migration-boundary.md)（本片逐条承接它的 A 档行）；[phase-1/05 适配原型](../phase-1/05-cordis-adapter-prototype.md)；[契约](../phase-1/01-core-api-contract.md) §3.3/§4.6/§7；[manifest 稿](../phase-1/03-plugin-manifest.md) §5.2/§6；[Phase 1 报告](../phase-1/report.md) §3；[ADR-0010](../../adr/ADR-0010-runtime-tool-registration-channel.md)（本片可见面扩展的决策记录）

## 1. 这份文档回答什么

一句话问题：**一个按旧框架写的插件，在自己的舱里调用旧 API 注册工具，这条链路在 Keel 上到底怎么走通——谁构造那个"旧形状的 ctx"、注册动作要跨哪几道缝、失败了从哪里看得见。**

本片交付三条主张（每条都有可断言的落点，见 §8）：

1. **承接层有真实进程路径**：旧 ctx 面在 Cell 进程内构造，注册写进 Core 的 scope 分区与 Cell 的私有执行表两半，被调度的工具确实是这条链注册出来的；
2. **A 档样本一行不改跑通**：合成插件用旧书写习惯（CommonJS、宿主注入 ctx、不 import 框架），"零改动"是机械判据而不是口头声明（§7）；
3. **映射不到的一律当场可见失败**：拒绝走错误码 + 账本留痕，不返回空表、不返回 undefined、不排队后偷偷成功。

本片**不做**（移交后续切片）：manifest 合成与权限收敛（②）、C 档三条改法与迁移手册（③）、D 档拒绝与策略 hook 装配链（④）、`throughSeq`/快照落盘/drain/流式（⑤）、真样本复跑与符号闭环收口（⑥）。

## 2. 开工前的事实核对（四条，决定了本片的形状）

设计稿先立事实，再立方案。以下四条是对现有代码的核对结果，前两条是**本片必须补的缝**，后两条是**必须如实登记的证据边界**：

| #   | 事实                                                                                                                                                                                | 后果与本片处置                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Core 可见工具表在**生产接线里从未被插件填充**：`ctx.registerTool()` 只有测试 rig 与适配原型手工调用；CLI/tests 跑出的 run 里 `tool.discover` 返回空表，脚本 driver 直接点名工具执行 | "会话间工具表互不可见"（B1 主张）目前无法由插件自证——本片把注册链路打通，让可见表由插件的运行期调用填充（§5）                                                    |
| F2  | 适配原型的 `createCordisCtx({ctx, ref})` 在**宿主进程内**绑定 `ContextManager`，只覆盖可见性一半（无 handler、无 Cell 执行表）                                                      | 旧插件真正的运行期注册（含 handler）没有路径；本片新增 Cell 内构造的承接面，宿主侧端口保留为诊断/施加面（§4）                                                    |
| F3  | manifest 能力词表（`permissions`）进账本（`ASSEMBLY_RECORDED`）但**不参与运行期裁决**：授权策略由调用方手写 allow 列表                                                              | 新通道 op 若不做能力门禁 = 给不受信进程开了一个无裁决的 Core 状态写口（违反 I4）。本片补"声明→规则"最小编译（§5.3）；完整的合成声明收敛留切片②                   |
| F4  | 当前隔离后端是子进程（ADR-0005），**Cell 内直接调用原生 `fetch`/`fs` 不被拦截**：`net.*`/`fs.*` 词表只在跨通道调用的授权裁决上有意义，单测级验证                                    | 证据边界：本片与 B1 的表述不得写成"越权直连被拦截"；`net`/`fs` 的运行期强制依赖容器/microVM 后端（backlog，触发条件见 ADR-0002/0005）。登记进 Phase 2 报告限制节 |

## 3. 承接面清单（旧 `ctx` 面 → 本片行为）

旧框架没有公开的 API 文档，本表是**我们为合成样本所定义的旧面**——它是样本的编写依据，也是 B5 符号闭环的基线（§8）。所有者确认它等同于确认"合成组覆盖了哪些设想写法"。

| 旧面符号                                                                                              | 本片行为                                                                                       | 边界行 / 落点                            |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `ctx.tools.register(name, schema, handler)`（位置形）与 `register({name, schema, handler})`（对象形） | 映射：写 Cell 执行表 + 跨通道注册 Core 可见表，返回 `Promise<{name, schemaVersion}>`（§5、§6） | #1 → **A**（返回值同步消费见 §6）        |
| `ctx.tools.remove(name)`                                                                              | 映射：两半都撤，返回 `Promise<boolean>`（是否真存在过）                                        | #1 → **A**                               |
| `ctx.tools.list()`                                                                                    | 映射：`tool.discover` 的本 scope 视图，返回 `Promise<view[]>`                                  | #1 → **A**                               |
| `ctx.hooks.register(...)`（启动期塞钩子）                                                             | 抛 `ADAPTER/UNSUPPORTED`：能力插件不持钩子面，钩子只由 `kind:"policy"` manifest 按白名单声明   | #2 拆支 → 归 #14 **D**（见 §10 第 2 项） |
| `ctx.share.get/set`（跨插件共享状态）                                                                 | 抛 `ADAPTER/UNSUPPORTED` + 改法提示（**绝不返回 undefined 装作读到空值**）                     | #8 → **C**，样例在③                      |
| `ctx.effects.reclaim(id)`                                                                             | 抛 `ADAPTER/UNSUPPORTED` + 改法提示（声明式补偿）                                              | #9 → **C**，样例在③                      |
| `ctx.llm.*` / 插件自带 SDK 直调模型                                                                   | 抛 `ADAPTER/UNSUPPORTED` + 改法提示（走 `client.modelInvoke` 形状）                            | #6 → **C**，样例在③                      |
| `ctx.config.get(key)` / `ctx.net`                                                                     | 抛 `ADAPTER/UNSUPPORTED`（B 档：等合成声明与受控注入通道）                                     | #4 / #5 → **B**，在②                     |
| `ctx.bus.emit/on(...)`（跨插件事件总线）                                                              | 抛 `ADAPTER/UNSUPPORTED` + 改法提示（工具参数传递 / 账本只读面）                               | #15（本轮新增行）→ **C**，样例在③        |
| 作用域自省（`ctx.sessionId` 等）                                                                      | **不提供**（旧代码读到 undefined）：作用域由通道绑定盖章，Cell 不自报身份；真样本命中即补表    | 新符号 → 待 B5 回填                      |
| 插件日志（`console.*`）                                                                               | 原样放行到 Cell stderr（不入账本，不拦截）；观测面仍是账本                                     | #11 → **B**，在②/⑥                       |

姿态三条（不可协商，与 01 稿 §1 判据同源）：

1. **不提供 ≠ 静默成功**：未映射的旧面一律抛错并写明改法去处；返回空表/undefined 就是把旧框架的隐式降级搬进新框架。
2. **`ADAPTER/*` 只用于"旧面映射缺失"**：运行期裁决失败原样抛 Core 错误码（`AUTH/DENIED`、`CTX/SCOPE-UNKNOWN`），承接层不改写、不包装成自己的码——归因链必须指向内核。
3. **承接层不持有工具表**：单一事实源仍是 Core 的 scope 分区；任何"本地记一份全量"的做法都等于把全局注册表搬回 Keel（原型稿 §5 第 2 条继续有效）。

## 4. seam：旧 ctx 在哪里构造，谁绑定作用域

**定案 D-a：承接层自带一个 Cell 进程入口，宿主用"换入口"的方式承载旧插件；`spawnCell` 的对外形状不变。**

```
宿主（每 run）                                   Cell 进程（旧插件）
supervisor.spawnCell({manifest, pluginPath, cellEntry: <adapter/dist/cell-entry.js>})
  └─ spawn(entryPath=cellEntry, bootstrap={pluginPath, toolCallTimeoutMs})   ← 形状不变
       └─ cell-entry.js：
            1. startCell(...) 取 CellHandle + CellClient（复用 @keel/cell-runtime）
            2. createCordisCellCtx(cell, client) 构造旧形状 ctx（作用域在此不可见、不可自报）
            3. 载入旧插件模块（CJS 优先）→ 归一化激活形状 → activate(ctx)
            4. 注册动作经 ctx.tools.* 落到 §5 的两半链路
  └─ serveCellChannel(cell.conn, binding, deps)   ← 现有缝，新增两个 op（§5.1）
```

要点：

- **bootstrap 不扩字段**：入口本身就是"这是旧插件"的信号，`{pluginPath, toolCallTimeoutMs}` 形状不动，旧插件的材料继续走同一条 spawn 路径；
- **CJS 用 Node 的 CJS 装载器**（`await import(pathToFileURL(...))` 对 `.cjs` 走 CJS loader）：插件内部的动态 `require`、`__dirname`、`require` 缓存都按旧习惯工作，且**每 Cell 一进程 = 装载缓存天然私有**（探针 P-1/P-2/P-3 的断言基础）；
- **旧模块形状归一化**（承接层做的唯一"翻译"，只认形状不改代码）：`module.exports = fn(ctx)` / `module.exports = {activate}` / ESM `export default fn` 三种都接受；认不出即 `ADAPTER/ENTRY-UNKNOWN` 崩溃退出（可见失败，不猜）。

被否方案与理由：

| 备选                                       | 否掉的理由                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 宿主进程代插件注册（原型现状扩到全量）     | handler 留在插件进程，注册却在宿主可见表里 = 名字可见而不可执行；且宿主持有插件语义，破 I1  |
| `cell-runtime` 直接内置旧 ctx 面           | cell-runtime 零依赖、面向新生态；把兼容面塞进内核执行单元 = 病灶进内核                      |
| 每类插件各建一个 `CellSupervisor`          | supervisor 只是 provider + 默认入口的胶水，为了一个路径参数复制整套生命周期管理是意外复杂度 |
| 靠 `export const tools` 静态声明（新形状） | 那要求插件改写（B/C 档），与 A 档"一行不改"矛盾；旧插件的注册本来就发生在 activation 里     |

## 5. 注册链路：两个新 op、两半提交、一次门禁

### 5.1 新增 Cell→Core op（契约可见面的扩展）

| op              | 方向      | 语义                                                                                                       | 默认超时 | 幂等性                                         | 主要错误                                                 |
| --------------- | --------- | ---------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- | -------------------------------------------------------- |
| `tool.register` | Cell→Core | 把 `{name, schema}` 写入**本 scope** 可见表；版本号由 Core 侧按现有条目 +1 指派并回给 Cell；不携带 handler | 200ms    | 否（重复调用 = 覆盖且版本再 +1，与旧框架一致） | `AUTH/DENIED`、`CTX/SCOPE-UNKNOWN`、`TRANSPORT/BADFRAME` |
| `tool.remove`   | Cell→Core | 从本 scope 撤名；返回是否真的存在过（`newSchemaVersion=0` 传播）                                           | 200ms    | 是（第二次返回 false）                         | 同上                                                     |

三处缝补齐，`@keel/core` 零改动（版本推导用现有 `discover`，撤名前查存在性——与原型同一套推导，不新增 Core API）：

- `packages/host/src/cell-server.ts`：两个 op case + 拒绝留痕（走 `auth.check`，见 5.3）
- `packages/cell-runtime/src/cell.ts`：`CellClient.registerTool/removeTool` 两个方法 + `CellHandle.removeTool(name)`（撤名与回滚都要它）
- `packages/cordis-adapter/`：旧面端口（§3）+ Cell 入口 + 宿主端口（保留）

### 5.2 两半提交的次序与回滚

注册触碰两份状态：Cell 私有执行表（能不能跑）与 Core scope 分区（能不能被看见、进不进决策输入）。**先写执行表，再跨通道写可见表；可见表写失败立即回滚执行表**，错误原样抛给插件：

```
registerTool(name, schema, handler)
  ├─ 1. cell.registerTool(...)          本地占位（同名 = 覆盖）
  ├─ 2. await client.registerTool(...)  Core 裁决 + 分区写 + 挂起变更日志
  ├─ 失败 → cell.removeTool(name) → 抛（Core 码）      ← 不留"可见而不可执行"的空壳
  └─ 3. 返回 {name, schemaVersion}（Core 指派的真实版本）
```

为什么这个方向：Core-first 的失败会留下**可见但不可执行**的工具——决策能选中它、执行必失败，那是最坏的静默降级形态；本地-first 的失败窗口是"可执行但不可见"，没有名字进决策输入就不可能被选中，且同一步内回滚关掉。

崩溃窗口（第 2 步之后、进程猝死）：Core 分区里有名字而执行表已随进程消失。因为 Cell↔Run 一一对应（契约 §3.2），进程死 = 该 run 以 `RUN_FAILED{CELL/CRASH}` 收束，不存在"别的会话来踩这个空壳"的路径；恢复延续走新 runId，重放由新 Cell 重新注册。本片不为这个窗口加清理机制。

生效时刻与账本：`registerTool` 写的是 scope 挂起变更日志，**下一轮**读上下文时由调度器取走并写 `TOOL_SCHEMA_CHANGED`（沿用 V1 传播语义，不新增事件类型）。因此"运行期内注册的新工具最早在下一轮进入决策输入"是预期行为，样本 A-3 按此断言。若注册发生在末轮之后，变更不入账（run 已结束，无可作用对象）——不作为缺陷处理，但写进样本注释。

### 5.3 能力门禁：把封闭词表接进运行期裁决（F3 的最小闭环）

新 op 是 Core 状态的写入口，必须默认拒绝。本片补一个纯函数（`packages/host/src/permission-rules.ts`，约 45 行）把 manifest 声明编译成授权规则，并由 rig/CLI 接线使用：

| cap（manifest §5.2）             | 产出规则 `subject × action × resource`                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tool.provide`                   | `tool.register` / `tool.remove` 各一条；`allow` 缺省 = `*`，给了 `allow` 就逐条收窄（词表"工具清单在代码内"不变，但可限名） |
| `model.adapter`                  | `model.invoke`（`allow` 缺省 = `*`）                                                                                        |
| `net.fetch`/`fs.read`/`fs.write` | 对应 action + `allow` 限定符（**注意 F4：只对跨通道的调用有意义**）                                                         |
| `memory.backend`                 | 无对应运行期 op → **不产出规则**（声明不 = 能力），仅在装配记录里保留                                                       |

裁决点：`tool.register`/`tool.remove` 在 handler 内先 `auth.check(ref, subject, "tool.register", name)`——拒绝即 `AUTH_DENIED` 落账（谁、做什么、对哪个工具、哪版策略、为什么），且不写任何一半状态。承接层不自作通道级重试（重复调用就是旧框架的覆盖语义，重试会凭空加版本）。

**实现期细化：激活就绪与首轮可见性（施工时发现的时序事实，不改上述结论）。** 真实子进程起飞要上百 ms，而调度器的轮次是瞬时的——同 tick 起 run 会在第 1 轮读到空表。这不是缺陷（注册链路本来就跨进程），但它是**测试必须显式处置的一段时序**：本片的 rig 在 driver 里设一道"激活屏障"，等到位再走断言计划，等到的是"舱已退出"则放弃等待、按原计划继续（负例路径由此自然收成一次可见崩溃）。屏障只用**既有**信号，不新增帧：旧入口以内核分区里出现 activation 注册的名字为凭（分区写只能来自注册帧），默认入口以一次 `tool.exec` 探测得到应答为凭（`main.ts` 在动态 import 之后才装 serve 处理器，且静态工具同步登记完才回到事件循环）。生产宿主不走这条路——它的对应物是"装配就绪之后才起 run"，那是切片② 装配链要正式定义的时机（登记进 §12 限制 5）。

## 6. 同步/异步定案（A 档的一处真实让步，必须先讲清）

旧框架的注册是同步的：写进程内全局表，计数器就地 +1。Keel 里可见表的唯一持有者在 Core 进程，跨进程写就是一次 await。**本片定案：Cell 侧 `ctx.tools.register/remove/list` 返回 Promise。**

被否的替代方案是"同步返回 + 本地排队 + 后台 flush"，它看着更像旧 API，代价是：

- 版本必须由 Cell 自己算才敢同步返回 → Cell 得记一份版本表 → 违反 §3 姿态 3（搬回全局注册表）；
- flush 失败发生在插件看不见的时刻 → **就是静默降级**，01 稿判据第 3 条直接否决。

不 await 的旧代码怎么办（这是 A 档能不能称"零改动"的关键）：

| 旧写法                                                       | 本片行为                                                                                                                                  | 是否可见失败                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ctx.tools.register(a, s, h);` 即发即弃                      | 正常注册；若该次调用被 Core 拒绝，拒绝以未决 Promise 拒绝浮现 → Cell 进程 `unhandledRejection` → 非零退出 → `RUN_FAILED{CELL/CRASH}` 落账 | ✅（01 稿 #10 的既有主张：崩溃从此是可见事件）   |
| 在 `async` activation / handler 里 `await`                   | 正常，拿到 `{name, schemaVersion}`                                                                                                        | ✅                                               |
| `const {schemaVersion} = ctx.tools.register(...)` 同步取版本 | 取到 undefined——**行为差异**，属 C 档一行改写（加 `await`）                                                                               | ✅ 不静默，且必须在边界表 #1 补注（§10 第 2 项） |
| `ctx.tools.list().filter(...)` 同步消费整表                  | 同上（Promise 无 `.filter` → TypeError → 可见崩溃）；改法 = `await`                                                                       | ✅ 同上                                          |

结论：**注册/下线/列表的"动作"是 A 档；对这些调用"返回值"的同步消费是 C 档的一行 `await`**。这条区分要写进边界表 #1 的实现期细化，不能只留在本稿——否则 B1 的表述会超出它实际证明的东西。

宿主侧端口（原型保留、A1 继续用作增删施加面）与 Cell 侧端口收敛为同一个 `CordisRegistryPort` 接口、同一套 Promise 签名（宿主端口返回已 resolve 的 Promise）。好处：A1 与真实路径形状一致，A1 的结论可以直接迁移；代价：`tests/concurrent-scope-isolation.test.ts` 三处调用点补 `await`，断言与主张不变，改完**必须按 S-001 复跑 A1 三次逐项一致**（B8 不退化的一部分）。

## 7. A 档合成样本组（含最坏写法探针）

材料性质先声明：以下样本按 01 稿 §5 的约定是**合成材料**，证明"我们设想的写法已验证"，不证明"真实存量插件可迁移"。manifest 由 rig 内联构造并声明 `tool.provide`（合成声明路径 = 切片②），样本目录只放插件源码。

**零改动机械判据**（不满足即不算 A 档样本，`tests/cordis-symbol-scan.test.ts` 强制）：

1. 样本一律 `.cjs`，用 CommonJS 书写习惯（`module.exports`、`require`、`__dirname`）；
2. 源码内**不得出现** `@keel/` 与任何 Keel 符号（`startCell`/`CellClient`/`serveCellChannel`…）——ctx 完全由承接层注入，插件不 import 框架；
3. 承接层不改写样本源码（无 AST 变换、无垫片注入、无代码字符串求值替换）；
4. 为通过测试而修改样本源码 = 该样本作废，重新计数；
5. 样本里出现的每个 `ctx.*` 符号必须命中 §3 的承接面清单（未命中即 B5 缺口，先补表）。

常规样本（5 枚，锚边界行 #1/#2/#10/#13）：

| 代号                 | 旧写法要点                                                                      | 断言落点                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `tierA-01-toolset`   | activation 里用**位置形 + 对象形**两种调用注册 3 个工具，handler 回显入参       | 三个名字进入本 scope 可见表并被 driver 选中执行；`TOOL_INVOKE/TOOL_RESULT` 齐；`TOOL_SCHEMA_CHANGED` 三条 `affectedScope` = 本域 |
| `tierA-02-overwrite` | 同名重复注册（覆盖语义），schema 变一次                                         | 可见表版本单调 +1 且**同名两次只有一条**；另一会话对同名工具的版本不受影响（各域各版本）                                         |
| `tierA-03-dynamic`   | handler 内 `await register` 新工具 + `remove` 现有工具                          | 新工具**下一轮**起可被选中（本轮决策输入已定）；被撤名字从可见表与执行表同时消失，再点名得 `CELL/TOOL-UNKNOWN` 错误留痕          |
| `tierA-04-crash`     | 旧式 `try/catch` 吞一处 + `setImmediate(()=>{throw})` 制造未捕获异常            | 该 run `RUN_FAILED{CELL/CRASH}`；邻居会话指纹与事件零扰动（#10/#13 的 A 档语义在真实进程成立）                                   |
| `tierA-05-timer`     | activation 起 `setInterval` 常驻 + 一个耗时 handler（贴近 `toolCallTimeoutMs`） | 宿主主循环不被拖住（其他会话轮次耗时不因它劣化）；超时 handler 落 `status:"timeout"` 而非静默（#13）                             |

最坏写法探针（4 枚，合同 §2 明文要求；每枚都要给出"污染通道在结构上不存在"的证据，而不是"这次没发生"）：

| 代号            | 野路子                                                            | 探针断言（关键：负向证据要可断言）                                                                                                                                           |
| --------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe-require` | activation 内动态 `require("./lib/extra.cjs")` 并注册其导出的工具 | 装载成功且工具可见；同 scope 外的会话看不到（`require` 缓存 = 进程私有）；宿主进程未被 `require` 影响任何状态                                                                |
| `probe-proto`   | `Array.prototype.last = fn` / 给 `Object.prototype` 挂标记        | 另一会话的同名补丁读取结果为 `undefined`（跨进程不可能共享）；**宿主进程**的 `Array.prototype.last` 亦 `undefined`                                                           |
| `probe-global`  | `globalThis.__CORDIS_CTX__ = ctx`，第二个插件指望取到它           | 第二个插件读到 `undefined`（作用域互盲）；且若它改用 `ctx.share.get` → 当场抛 `ADAPTER/UNSUPPORTED`（**不返回 undefined 装作成功**）                                         |
| `probe-order`   | 依赖"别的插件先加载并注册 beta"的旧顺序耦合                       | 本域可见表只含自己注册的名字；点名他域工具 → `CELL/TOOL-UNKNOWN` 的 `TOOL_RESULT` 错误留痕；两域注册顺序相反时可见表内容一致（`discover` 稳定排序 → 缓存键不受注册顺序影响） |

driver 约定（让"注册链路真的被走通"可证伪）：A 档样本的 run 用**断言式 driver**——它只从 `discover` 送进来的可见表里选工具，预期工具缺席即让 run 明确失败（而不是脚本点名绕过可见表）。这条是 F1 的正面解法：可见表空 = 测试红，杜绝"执行链跑通了但可见性是假的"。

**实现期细化（样本落地时的三处收紧，都不放宽主张）**：

1. `tierA-05-timer` 的"耗时"拆成两条，因为它们是两件事：同步忙等（占本舱 CPU，在 `toolCallTimeoutMs` 之内，仍算一次成功）与**越界的异步挂起**（必须落 `status:"timeout"` + `TRANSPORT/TIMEOUT`）。同步忙等主要不了 timeout——`Promise.race` 在被占死的循环里到不了定时器，这条是 C-D3 硬强制的真实边界，写进样本注释而不是含糊过去。常驻定时器用"下一次调用让出一次事件循环后再读计数"来断言，不靠运气。
2. 断言计划里的条目可写成 `"name"` 或 `"name@version"`：复用同一 scope 的第二个 run，只等名字就会把"本舱注册到了 v3"漏成"分区里早就有 flip"。跨 run 的分区连续性因此是**正面断言**（第二 run 的可见表含上一 run 注册的条目），不是被绕过的坑。
3. "未报关的那家被挡下、邻居照常"需要邻居**自己**报关：反例 rig 用 `allow` 收窄出三条注册权（§5.3 的收窄在真实进程里第一次被跑到），未报关那家的 `should-not-appear` 命中不了任何规则。若整台策略不给注册权，邻居的失败就分不清是"被冤枉"还是"本该如此"。

## 8. 测试面与验收锚点

| 测试                                                | 内容（断言要点）                                                                                                                                | 锚定                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `packages/cordis-adapter/test/*.test.ts`（扩）      | 端口双实现一致性（宿主/内存假通道）；`ADAPTER/UNSUPPORTED` 清单逐项；未映射面不返回空值；形状归一化三种入口 + `ENTRY-UNKNOWN`                   | §3 承接面清单            |
| `tests/cordis-adapter-tier-a.test.ts`（新）         | 真实多进程：5 枚常规样本 + 4 枚探针在 ≥2 会话并发跑；B1 三主张逐条（账本完整 / 工具表互不可见 / 崩溃只伤本舱）；`tool.provide` 缺失的反例（N1） | **B1**、#1/#2/#10/#13    |
| `tests/cordis-registration-channel.test.ts`（新）   | 两半提交与回滚：拒绝后两半皆空、`AUTH_DENIED` 载荷齐；`TOOL_SCHEMA_CHANGED` 下一轮生效；`remove` 后点名 `CELL/TOOL-UNKNOWN`；同名版本 +1        | §5、F3                   |
| `tests/cordis-symbol-scan.test.ts`（新）            | §7 零改动判据 1/2 机械扫描 + 符号集合 ⊆ 承接面清单常量（`CORDIS_SURFACE` 由 adapter 导出）                                                      | **B5**（合成组这一半）   |
| `packages/host/test/permission-rules.test.ts`（新） | 词表→规则编译：`tool.provide` 无 allow = `*`、有 allow 逐条收窄；`memory.backend` 不产出规则                                                    | §5.3                     |
| `tests/concurrent-scope-isolation.test.ts`（改）    | 端口签名统一带来的 `await`（3 处），主张不变；改后复跑 3 次逐项一致                                                                             | B8（Phase 1 主张不退化） |

B1 的三条主张与本片的对应：**账本完整** = 每样本 run 的 seq 连续 + `ASSEMBLY_RECORDED` 首事件 + 注册变更入账；**互不可见** = 每会话可见表只含本域注册名（探针 `probe-order`/`probe-global` 专门攻击这一条）；**崩溃只伤本舱** = `tierA-04-crash` 与静止邻居会话的对照。

## 9. 体量、依赖与门禁影响

- 代码增量预估：`cordis-adapter` 由 127 行扩为 4 个文件（`index.ts` 面与类型 / `port-host.ts` / `port-cell.ts` / `cell-entry.ts`）≈ 320 行；`cell-server.ts` +约 45 行、`cell.ts` +约 20 行、`supervisor.ts` +约 8 行（per-spawn 入口覆盖）、`permission-rules.ts` 新文件约 45 行；`core` 0 行。全部远离 600 行红线，最大文件仍是 `scheduler.ts`。
- 依赖：新增 0 个三方依赖（`cordis-adapter` 加 workspace 内部依赖 `@keel/cell-runtime`，其自身零依赖 → 不成环；`tsconfig.json` 的 `paths` 同步补一条，见 P-004）。
- 文档：docs 新增本稿（+ 本轮已另立 [ADR-0009](../../adr/ADR-0009-await-async-resource-release.md) 记录资源释放规范补条）；本片定稿后还需 1 篇契约可见面 ADR（编号顺延 ADR-0010）；阶段文档增量仍在 ≤12 篇内。
- 门禁：六道 + `pnpm clean` 起全链一次；Phase 1 契约级五测试点与 A1~A8 场景全部复跑（B8）。

## 10. 所有者确认结果（2026-11-03，三项均按建议）

1. **契约语义扩展已授权** → 已立 [ADR-0010](../../adr/ADR-0010-runtime-tool-registration-channel.md)：新增两个 Cell→Core op（`tool.register`/`tool.remove`）+ `tool.provide` 的语义从"代码内清单（装载期）"扩到"运行期可注册/撤名"；契约 §3.3 Cell 行、§4.6 与 manifest §5.2 追加实现期细化注记。
2. **边界表两条补注已认可**：#1 补"返回值同步消费属 C 档（一行 `await`）"；#2 拆支——"启动期塞工具"留 A 档，"启动期塞钩子"归 #14 的 D 档通道（策略插件 + 白名单声明）。01 稿以"实现期细化"追加，不改判档结论。
3. **样本组规模 9 枚已认可 + 新增行 #15**：A 档合成组 = 5 常规 + 4 探针；`ctx.bus.emit/on`（旧框架跨插件事件总线）新增为边界行 **#15，归 C 档**，本片按"未映射即抛"处置（改法 = 工具调用参数传递或经账本只读面）。

## 11. 定稿后的落地清单（按序）

- [x] `docs/adr/ADR-0010-*`（契约可见面扩展，含 5.3 的能力门禁理由与被否方案）
- [x] 契约 §3.3 / §4.6 与 manifest §5.2 追加"实现期细化"注记（只追加，不改既有结论）
- [x] 边界表 01 稿 #1/#2 补注（依 §10 第 2 项确认结果）
- [x] `cell-runtime`：`CellClient` 两方法 + `CellHandle.removeTool`
- [x] `host`：`cell-server` 两 op case、`supervisor` per-spawn 入口覆盖、`permission-rules` 新模块
- [x] `cordis-adapter`：端口抽象与双实现、Cell 入口、形状归一化、`CORDIS_SURFACE` 常量
- [x] §8 五份测试（先写红色断言再补实现——铁律 7 对新链路同样适用）
- [x] A1 测试端口签名统一 + 复跑 3 次逐项一致（B8）
- [x] 体量核对 + 六道门禁（`pnpm clean` 起）；CHANGELOG / docs/README / CONTEXT / handoff 收尾四件事

## 12. 本片的限制（先登记，别等报告）

1. 合成样本证明的是设想写法，不是真实插件（合同风险 1；表述纪律在 CONTEXT 已挂）。
2. 作用域自省面不提供、`ctx.bus`/日志订阅等旧面未映射——真样本到位后按 B5 补表义务处置。
3. `fs`/`net` 词表的运行期强制仍受 F4 约束（进程后端不拦截舱内原生调用）；B2/B4 的证据措辞要按这条写。
4. 策略插件 → hook 总线的装配链未动（切片④）：本片样本全部是 capability 形状。
5. **激活就绪时机不在本片定义**：契约里没有"舱内 activation 完成"的信号，本片用 rig 内的屏障观察（§5.2 实现期细化）。生产上这条不能靠猜——切片② 的装配链必须给出正式的"就绪之后才起 run"时机，否则旧插件的第一轮决策拿到的是空表。
6. **`toolCallTimeoutMs` 拦不住同步 handler**：`Promise.race` 的定时器要在事件循环里才跑得动，被同步忙等占死的舱内不会有 timeout 落下。能落 timeout 的是异步挂起（本片样本已覆盖）；同步失控只能靠 Supervisor 的强杀后盾（killed 分类），代价是整个舱。这条要写进 B 组证据的措辞里，不得写成"耗时调用一律有 timeout"。
