# Phase 2 切片③：C 档改法的地面与迁移手册

- 状态：**定稿**（2026-11-03 所有者确认 §8 三项，全部按建议落地：模型改法走带请求号的新面 / 本片补 `ctx.ledger.read` / 手册覆盖全部 7 条 C 档行而真样本只做 B3 三条；定稿后开始写本片实现代码——铁律 1）
- 日期：2026-11-03
- 关联：[phase-2 合同](../../roadmap/phase-2-cordis-compat.md) §7 切片③（锚 **B3**）、§2「做」的迁移手册条目、§6 风险 3；[01 稿 迁移边界](01-cordis-migration-boundary.md)（C 档行 #1 的 await 支 / #4 / #6 / #8 / #9 / #12 / #15）；[02 稿 承接层骨架](02-adapter-skeleton.md) §3 姿态与 §12；[03 稿 声明合成](03-manifest-synthesis.md) §10 第 3 项（#4/#12 改判 C 的后续归属）；[契约](../phase-1/01-core-api-contract.md) §3.3/§4.1/§4.6/§4.7/§8；[ADR-0011](../../adr/ADR-0011-cell-load-gate.md)

## 1. 这份文档回答什么

一句话问题：**旧插件里那三类"必须改一小段"的写法——自己调大模型、跨插件共享可变状态、出事再回收副作用——在 Keel 上改成什么才算真的能跑，而且这个"改法"本身要有可跑证据，不是手册里的一句建议。**

三条主张（每条都有可断言落点，见 §5）：

1. **旧面继续显式拒绝，改法走新增的 Keel 形状面**：`ctx.model.invoke` / `ctx.effects.declare` / `ctx.ledger.read` 三个面，全部映射到**已有的通道 op**（`model.invoke` / `effect.declare` / `ledger.read`）。零协议变更、零新 op、零新错误码；`ctx.llm.chat`、`ctx.effects.reclaim`、`ctx.share.*`、`ctx.bus.*` 一个都不放行。
2. **三条 C 档各一对 before/after 真进程样本**：before 必须**可见失败**（拒绝或"账本里一条事实都没有"），after 必须**跑通且有账本凭据**——B3 的三条口径逐条可断言（预扣/实结/同 id 重放不重复计费；跨域互不可见且值经工具参数传递；声明期报关 → 运行期失败 → 补偿真的执行且重派幂等）。
3. **迁移手册覆盖全部 C 档行**，但只有 B3 三条落成真进程样本：其余四条（#4 声明能力、#12 显式调用、#15 事件总线、#1 的同步消费返回值）在手册里给 before/after 片段并**指向已有证据**（切片① 的 async 注册、切片② 的缺项清单、本片的账本只读面）。

> 为什么这一片值得单独切：**"改法"今天没有地面**。F1 说清了——承接层今天只映射了注册面，三条 C 改法在代码里没有可调用去处，手册只能写"应该这么改"；而内核侧的能力其实早就齐了（F2），缺的只是舱内那一段映射。

## 2. 开工前的事实核对（九条，源文件可核）

| #   | 事实                                                                                                                                                                                                                                                                                                                                            | 后果与本片处置                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 承接层只映射了注册面：`CORDIS_SURFACE.mapped = tools.register/remove/list`，其余旧面一律抛（`packages/cordis-adapter/src/core.ts` §CORDIS_SURFACE 与 `refused()`）                                                                                                                                                                              | 三条 C 改法**今天没有落地面**；本片补三个 Keel 形状新面，旧面一条都不放行                                                                                                             |
| F2  | 内核侧能力已就绪：`CellClient` 已暴露 `modelInvoke` / `declareEffect` / `ledgerRead`（`packages/cell-runtime/src/cell.ts`），`cell-server.ts` 已实现三 op 的裁决与留痕                                                                                                                                                                          | 本片是**接线**不是新机制：不动契约、不加 op、不加错误码                                                                                                                               |
| F3  | 网关的幂等口径要求 **reqId 由调用方给出**：同 reqId 命中已结算表 → `replay:true`，不重打上游、不重复计费（`packages/core/src/gateway.ts`）；旧 `ctx.llm.chat(prompt, opts)` 形状里没有请求号                                                                                                                                                    | 这才是 #6 属"必须改写"的实质原因（不是风格问题）：**自动生成 reqId 等于每次都是新请求**，重放保护在旧插件侧就失去落点 → 新面把 reqId 摆成第一个入参                                   |
| F4  | 效果声明必须命中 manifest 已声明模板：`effect.declare` 对未声明的 `effectKind` 抛 `SCHED/MANIFEST-INVALID` 且**不落 `EFFECT_DECLARED`**（`cell-server.ts` 的 `declareEffect`，C-M1 焊点）                                                                                                                                                       | #9 的 after 必须同时改两处：manifest 加 `compensation.templates` + 代码把"动手后 reclaim"换成"动手前 declare"；旧 `effects.reclaim()` 保持拒绝（它就是"临时决定回收"的形态）          |
| F5  | 补偿动作执行体在舱内：宿主补偿执行器 spawn **同一插件的新 Cell** 调 `compensation.exec(actionRef)`（`packages/host/src/compensator.ts` + `cell.ts` 的 switch）；默认入口从 ESM 的 `export const compensations` 登记（`cell-runtime/src/main.ts`），**承接层入口什么都不登记**（`cordis-adapter/src/cell-entry.ts` 只做 activation + markReady） | #9 需要一个旧形状能表达的登记约定：`module.exports.compensations = { "<actionRef>": fn }`，由 cell-entry 在装载时接出来喂 `cell.setCompensations`——形状换、语义不换，且不代插件造动作 |
| F6  | 分区是 scope 级且 Cell 不持有作用域（`core/src/context.ts`；`ctx.scope` 读取即抛）                                                                                                                                                                                                                                                              | #8 的 after 只能"谁产生谁持有 + 经工具参数或只读账本传递"——**没有共享面可以映射**，手册要写清这是设计而不是缺失                                                                       |
| F7  | 两条端口不对称：`buildCordisCtx(port)` 只吃注册端口，宿主端口（`host-port.ts`，Phase 1 A1 的施加通道）背后没有网关/账本/追踪器                                                                                                                                                                                                                  | 新三面在宿主端口上**必须显式拒绝**（`ADAPTER/PORT-UNSUPPORTED`，写明"诊断端口不假装能跑真链路"），与 02 稿 §2 F2 同一条姿态                                                           |
| F8  | 集成 rig 的上游是写死的零用量桩（`tests/fixtures/cordis-rig.ts`：`upstream: { invoke: async () => ({ result:{}, usage:{tokens:0}, cost:0 }) }`）                                                                                                                                                                                                | B3 要观察预扣/实结/重放，rig 需把 upstream 变成可注入 + 可计数（小改，既有主张不变）                                                                                                  |
| F9  | 两处文案滞后：`core.ts` 的 `WAY_OUT.config` 与 `CordisCtx` 注释仍写 #4 是 B 档（切片② 定稿已改判 C，01 稿 §3 已更新）                                                                                                                                                                                                                           | 本片一并纠正——只改指向与档位字样，不改任何结论                                                                                                                                        |

## 3. 方案：三个改法面 + 三对样本

### 3.1 新增面（舱内端口实现；宿主端口抛错）

| 新面（旧插件要改写出来的那一行）                                                        | 映射到                 | 载荷与返回                                                                        | 失败形态（原样浮出 Core 码，承接层不改写归因）                                |
| --------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ctx.model.invoke(reqId, { model, params, estimate })`                                  | `client.modelInvoke`   | 返回 `{ result, usage, cost, replay }`；`estimate` 必填（预扣依据，内核权威计量） | `AUTH/DENIED`（未声明 `model.adapter`）、`BUDGET/*`、`GATEWAY/UPSTREAM-ERROR` |
| `ctx.effects.declare({ effectId, effectKind, targetSummary?, dependsOn?, retention? })` | `client.declareEffect` | 返回 `{ effectId, seq }`                                                          | `SCHED/MANIFEST-INVALID`（模板没报关，C-M1）、依赖成环/未知引用               |
| `ctx.ledger.read({ types?, seqFrom?, seqTo? })`                                         | `client.ledgerRead`    | 本 run 的事件页（宿主强制覆盖 `filter.runId`，Cell 自报的 runId 一律忽略）        | 通道/帧层错误                                                                 |

三条姿态不变：旧面（`llm.chat` / `effects.reclaim` / `share.*` / `bus.*` / `net.fetch` / `config.get`）**一律仍抛 `ADAPTER/UNSUPPORTED`**，只是 `WAY_OUT` 文案改为指向上面对应的地面；新面不是"旧面改名"，而是**改写后才能拿到的地面**——这正是 C 档的定义（代码要改一小段）。

### 3.2 符号闭环（B5）的扩展方式

`CORDIS_SURFACE` 加第四桶 **`guide`**（改法地面清单：`model.invoke` / `effects.declare` / `ledger.read`）。`tests/cordis-symbol-scan.test.ts` 的判据改为：样本里出现的每个 `ctx.*` 符号必须命中 `mapped ∪ refused ∪ withheld ∪ guide` 之一，未归类即红（先补表再收口的义务不变）。
**为什么不是塞进 `mapped`**：`mapped` 的语义是"旧 API 已自动映射、代码不用改"，把需要改写的东西塞进去就是把 C 档谎报成 A 档——B5 的一票否决正针对这种漂移。

### 3.3 样本（`tests/fixtures/cordis-plugins/`，同一套零改动机械判据与 `.prettierignore` 保护）

| 行  | before（必须可见失败）                                                                                                                           | after（必须跑通并留下凭据）                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #6  | `tierC-06-self-key.cjs`：handler 里用进程自带能力直连假上游（账本关于它**零事实**）+ `ctx.llm.chat()` 直调（当场拒，`ADAPTER/UNSUPPORTED`）      | `tierC-06-gateway.cjs`：`ctx.model.invoke("req-1", {…})` 调两次同一 reqId → 第二次 `replay:true`；账本里 `BUDGET_RESERVED`/`BUDGET_SETTLED`/`MODEL_USAGE` 各只对**一次真实上游**计                                                                                                      |
| #8  | `tierC-08-share.cjs`：handler 里 `ctx.share.set("peer-key", …)` 写对方状态 → 当场抛 + `TOOL_RESULT{status:error}` 留痕，且**没有任何一半写成功** | `tierC-08-carry.cjs`：A 舱工具产出状态（留在自己舱里）→ 返回值经内核发给决策 → driver 下一轮把它作为 B 舱工具的入参；断言两域可见表互不可见 + 值确实换了舱                                                                                                                              |
| #9  | `tierC-09-reclaim.cjs`：动手后调 `ctx.effects.reclaim(id)` → 拒 + 账本里既无 `EFFECT_DECLARED` 也无补偿痕迹                                      | `tierC-09-declare.cjs`：manifest 报关 `compensation.templates` → handler 先 `ctx.effects.declare(...)` 再失败 → `EFFECT_DECLARED` + `RUN_FAILED` → 宿主补偿执行器 spawn 同插件新舱（承接层入口）执行 `module.exports.compensations` 里的动作 → `COMPENSATION_EXECUTED` 落账，重派不重复 |

**接线缺口（本片要补的一处）**：`apps/keel/src/runtime.ts` 的补偿动作舱今天固定走默认入口（`spawnCell({manifest, pluginPath})`，没有 `cellEntry` 位）→ `BuildRuntimeOptions.actionSpec` 增可选 `cellEntry`，`wireRun` 已有该位（切片②），旧插件的回滚闭环因此才走得通。这是 F5 的直接后果，不是新功能。

## 4. 迁移手册的形态（新增 `docs/design/phase-2/05-migration-handbook.md`）

- **读者是存量插件方**，不是本项目评审：每条 C 档一节，顺序按改动成本排（#1 的一行 `await` → #4 声明能力 → #6 走网关 → #8 拆共享状态 → #9 报关补偿 → #12 显式调用 → #15 总线改道）
- 每节固定五段：**旧写法片段**（CommonJS 原样，不做风格美化）→ **为什么这是病灶**（一句，指回 01 稿语义变化列）→ **改法片段**（可抄）→ **跑在哪**（本片样本名 / 既有证据链接 / 缺项清单口径）→ **行为差异**（从此有什么不一样）
- 手册**不承担验收**：可跑证据全在 §5 的测试里；手册**不给**"临时兼容开关"（无此物）、不给"先注释掉"的建议
- D 档两条（#7 自建控制流、#14 策略插件绕控制面）在手册末尾单列一节"这条路不存在，出路是 hook 白名单"——正文由切片④ 的装配链补证据（合同风险 3 的处置）

## 5. 测试面与验收锚点

| 测试                                                        | 内容（断言要点）                                                                                                                | 锚定           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `packages/cordis-adapter/test/guide-faces.test.ts`          | 三面形状 → 端口调用的映射（假 client 断言 op 名与载荷）；缺 estimate / 缺 reqId 即抛；**宿主端口抛 `ADAPTER/PORT-UNSUPPORTED`** | §3.1、F7       |
| `packages/cordis-adapter/test/legacy-compensations.test.ts` | cell-entry 把 `module.exports.compensations` / `snapshot` 接进 Cell 的登记面；无导出即不登记（不是登记空表）                    | F5             |
| `tests/cordis-c-surface.test.ts`                            | **B3 主战场**：三对样本真实进程跑；#6 的预扣/实结/重放三条计数断言；#8 的换舱传递与互不可见；#9 的报关→失败→补偿→幂等全链       | **B3**         |
| `tests/cordis-symbol-scan.test.ts`                          | 判据扩到 `guide` 桶；C 档样本齐备且每个 `ctx.*` 符号有归属；旧面仍全部落在 refused                                              | B5（本片增量） |
| `tests/concurrent-scope-isolation.test.ts` 等               | 不动，按 B8 复跑（A1 与 Phase 1 契约级五测试点 + 切片①②的 B1/B2/B6 组）                                                         | B8             |

## 6. 与切片①②的接缝（不重做）

- 切片① 的注册通道与两半提交不动；#1 的 await 支已在 A 档样本里跑过，本片只在手册里把它写成给插件方的第一条改法。
- 切片② 的 `runPolicy` / 五步校验是 #9 样本 manifest 的入口；#4 的"声明所需能力"由 03 稿 §4 的投影规则承担，本片不重做合成。
- 装载门（ADR-0011）对 #6/#9 有意义：旧插件在 activation 里就调用网关的话，请求会排在门外——本片**不**在 activation 期调用新面（样本都在 handler 里调用），并在 §10 登记为限制。
- rig 的 upstream 注入（F8）改完后，Phase 1 A7 的网关测试口径不受影响（它们自带 upstream）。

## 7. 体量、依赖与门禁影响

- 代码增量预估：`cordis-adapter/src/core.ts` +~55（三面 + guide 清单 + 文案纠正）、`cell-port.ts` +~35、`host-port.ts` +~12（抛错）、`cell-entry.ts` +~18（compensations/snapshot 登记）、`apps/keel/src/runtime.ts` +~6（`actionSpec.cellEntry`）、`tests/fixtures/cordis-rig.ts` +~15（可注入上游）。全部远离 600 行红线（最大实现文件仍是 `scheduler.ts` 569 行）。
- 文档：新增本稿 + `05-migration-handbook.md`（预估 ≤260 行，单篇红线 300）；01 稿 #6/#8/#9/#11/#12/#15 六行补"实现期细化"注记（追加，不改档位结论）。
- 依赖：新增 0 个三方依赖。契约：无改动（F2 是"能力已就绪"的直接结果）；**因此本片不立 ADR**——若 §8 第 1 项选"给旧面自动映射"，那才是改语义、需要 ADR。
- 门禁：六道 + `pnpm clean` 起全链一次；B8 复跑同前。

## 8. 所有者确认结果（2026-11-03，三项均按建议）

1. **#6 的地面形状 = 旧面仍拒 + 新面带请求号**：`ctx.llm.chat` 继续抛 `ADAPTER/UNSUPPORTED`（改法文案指向新面），新面 `ctx.model.invoke(reqId, {model, params, estimate})` 把请求号摆成第一个必填参数。两条被否的备选留下理由：① 给旧面自动映射并自造请求号 = 同请求重放保护在这条路上失效，还把 C 档谎报成 A 档，且要为幂等例外单立 ADR；② 由内核按"模型 + 参数摘要"派生幂等键 = 连"故意重发同样内容"也一起吞掉，改的是契约 §8 的幂等语义本身。
2. **本片补 `ctx.ledger.read`**：#11/#12/#15 三条改法共同的"读只读账本"出路因此有可跑形态。映射既有 op，作用域仍由宿主盖章（`filter.runId` 强制覆盖，Cell 自报一律忽略），零协议变更、零新错误码。
3. **手册覆盖全部 7 条 C 档行**（#1 的 await 支、#4、#6、#8、#9、#12、#15）都给 before/after 片段，其中只有 B3 三条落成真进程样本；其余四条指向已有证据（#1 → 切片① 的 async 注册；#4 → 切片② 的缺项清单；#12/#15 → 本片账本只读面 + 切片① `probe-order` 的耦合不成立实证）。合同 §2 那句"每条 C 档一个 before/after 样例"**按原文执行，不改口**。

## 9. 定稿后的落地清单（按序）

- [ ] 01 稿六行补"实现期细化"注记（#6/#8/#9/#11/#12/#15，追加式，不改档位）
- [ ] `cordis-adapter`：`CORDIS_SURFACE.guide` + 三面实现（core/cell-port/host-port）+ `WAY_OUT` 文案纠正（F9）
- [ ] `cell-entry`：`module.exports.compensations` / `snapshot` 的登记接线（F5）
- [ ] `apps/keel/runtime.ts`：`actionSpec.cellEntry` 透传（§3.3 末尾的缺口）
- [ ] rig：可注入上游 + 调用计数（F8）
- [ ] 三对 C 档样本 + `cordis-c-surface.test.ts`（**先写红色断言**，铁律 7）
- [ ] 两份单测（guide-faces、legacy-compensations）+ 符号扫描判据扩展
- [ ] `05-migration-handbook.md` 首版
- [ ] B3 验收 + B8 复跑；体量核对 + 六道门禁（`pnpm clean` 起）；CHANGELOG / docs/README / CONTEXT / handoff 收尾四件事

## 10. 本片的限制（先登记，别等报告）

1. **#6 的重放保护仍依赖插件自觉**：reqId 由调用方给出，内核只据它去重——同一次业务动作换了这个号就是新请求。这是契约 §8 既有口径，本片不改。
2. **不在 activation 期调用新面**：装载门（ADR-0011）会把门外请求排队，而旧代码常把"启动就连一次模型"写在 activation 里。本片样本一律在 handler 内调用；"activation 期调用新面"的真实形态要等真样本暴露后再定（进 backlog，别顺手做）。
3. **#8 的"只读注入"没有独立面**：01 稿 #8 写的"经内核只读注入"落在 `ledger.read`（本 run）与 `tool.discover`（本 scope），没有"别人状态"的注入通道——跨插件写永久拒绝（这是设计，不是缺失）。
4. **补偿动作形状仍要插件方自己给**：`module.exports.compensations` 只是"旧模块多导出一张表"，承接层不代造动作、也不把 `effects.reclaim` 翻译成补偿（那是把静默降级换了个名字）。
5. **快照面（`module.exports.snapshot`）本片只登记不持久化**：物理持久化在切片⑤（回填项 ②）；本片只保证"旧插件也能把私有状态暴露给宿主"这条通道存在。
6. **手册的 before 片段是"我们设想的写法"**：与 01 稿 §5 的材料性质同源——真样本到位后按同一义务回填，不得表述为"真实存量插件已验证"。
