# Phase 2 切片④：策略插件 → HookBus 装配链，与 D 档硬拒绝的证据

- 状态：**定稿**（2026-11-03 所有者确认 §7 三项，全部按建议落地：策略插件跑在自己的进程并立 [ADR-0012](../../adr/ADR-0012-policy-plugin-process-and-hook-op.md) / 同一插话点被抢时装配期整份拒 / 装配审计补 `policies` 字段；定稿后开始写本片实现代码——铁律 1）
- 日期：2026-11-03
- 关联：[phase-2 合同](../../roadmap/phase-2-cordis-compat.md) §7 切片④（锚 **B4【一票否决】+ B7①**）、§2「做」的回填项 ①、§6 风险 3 与风险 5；[01 稿 迁移边界](01-cordis-migration-boundary.md) #7 / #14（D 档零例外）；[05 稿 迁移手册](05-migration-handbook.md) §8；[契约](../phase-1/01-core-api-contract.md) §3.3 / §4.8 / §5 / §7；[ADR-0005](../../adr/ADR-0005-cell-isolation.md)、[ADR-0011](../../adr/ADR-0011-cell-load-gate.md)、**[ADR-0012](../../adr/ADR-0012-policy-plugin-process-and-hook-op.md)**（本篇定稿的直接产物）；[Phase 1 报告](../phase-1/report.md) §3 第 3 条（登记限制）与 §9 回填清单

## 1. 这份文档回答什么

一句话问题：**"策略插件只能插话、不能接管"这条主张今天有没有真进程凭据？以及把策略插件接进真实 run 的那段装配链，接在哪里才算不破不变量？**

三条主张（每条都有可断言落点，见 §4）：

1. **B4**：D 档两条（#7 自建预算/控制流、#14 策略插件绕控制面）在**装配期与运行期各有真实拒绝点**；每组样本都要同时给出"拒绝 + 留痕 + **零部分生效**"，其中"部分生效"用机械核对而不是口头保证。
2. **B7①**：策略插件（新生态形状）经装配链接入真实 run 后，四个白名单 hook 的每次介入都能从账本归因（`HOOK_CALLED` / `HOOK_VERDICT` + `DECISION.basedOn`），且**策略进程崩溃不级联到 run**。
3. **装配链的位置定死在"策略代码跑在自己的进程里"**：宿主只把 hook 入参发过去——这是契约 §3.3 那一行（"四个 hook 被调用（被动），无主动接口"／"除 hook 入参外的一切"不可见）的字面要求。

> 为什么这段值得单独切：F1 说清了——总线今天就摆在宿主进程里，**没有任何生产代码往里注册**。于是 `keel run` 跑出的真实运行永远没有策略痕迹，而 D 档的"绕控制面被拒"也只活在 in-process 单测里。链不接，两条验收都没有地面。

## 2. 开工前的事实核对（十一条，源文件可核）

| #   | 事实                                                                                                                                                                                                            | 后果与本片处置                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| F1  | `HookBus.register` 的调用者**只有测试**（`packages/core/test/hooks.test.ts`、`scheduler.test.ts`）；`apps/keel/src/runtime.ts` 构造 `new HookBus(ledger)` 之后无人注册                                          | B7① 缺的就是这一段接线；本片是**接线**，不是新机制                                                           |
| F2  | 四 hook 的调用点与留痕已就绪：`scheduler.ts` 306（stopAdvice）/417（toolApproval）/394·442（retryAdvice）/478（budgetExhaustedChoice），每次写 `HOOK_CALLED` + `HOOK_VERDICT` 并把 seqs 推入 `DECISION.basedOn` | 归因面不用重做；B7① 只需证明"插件来源的 handler"跑在同一条路上                                               |
| F3  | schema 已硬约束报关单：policy 分支 `hooks` 必填非空且只能取四值、`permissions`/`subscriptions` 必须空、`resources` 必须 `{}`、模板空、禁 `migration`；capability 分支 `hooks: {maxItems:0}`                     | D 档"能力插件持钩子面"与"策略插件持能力"都在**装配期第 1 步**就被拒——B4 的两枚负样本已有落点，只缺真产物证据 |
| F4  | `LoadedManifest.hooks` 被装配器收下来（`assembler.ts` 119 行 `m.hooks ?? []`），但**没有任何运行期消费者**                                                                                                      | 声明与生效之间是空的：接了链才有消费者；不接就是"报了 hook 也没人调"的第二张皮                               |
| F5  | 帧协议宿主→舱的 op 只有 `tool.exec` / `compensation.exec` / `cell.snapshot` / `cell.migrate`（`cell-runtime/src/cell.ts` 162-191）                                                                              | 策略方向没有通道：本片要加**一个**新 op（`policy.hook`）→ 属接口决策，须 ADR-0012（铁律 2）                  |
| F6  | 契约 §3.3 策略插件行：可见 = "四个 hook 被调用（被动），无主动接口"；不可见 = "除 hook 入参外的一切"                                                                                                            | **进程内 import 策略模块当场违反这一行**（模块能读宿主内存与内核命名空间）；这条是 §7 第 1 项的判据          |
| F7  | `CellSupervisor.onCellExit` 的 abort 缝以 `cell.ref` 为条件（`runtime.ts` 217-220：`if (ref)`）                                                                                                                 | 策略舱不 `attachRun` → 其退出不触发任何 run abort（I2 对）。但这条必须**有测试**，不能只靠"看起来不会"       |
| F8  | `ASSEMBLY_RECORDED` 载荷只有 `manifest/permissions/compensation/replacesVersion`（`core/src/events.ts` 85-93）                                                                                                  | 账本看不出"这个 run 绑了哪些策略"；策略没插话时尤其无痕 → §7 第 3 项决定是否扩展该载荷                       |
| F9  | hook 失败/超时/响应违规的 fallback 已实现且有单测（`hooks.ts` 47-55 默认策略、64-84 禁区校验、136-162 留痕），但都是 in-process                                                                                 | B4 要"运行期拒绝 + 留痕可查"：本片把同一判据搬到真进程（夹带下一动作的响应必须落 `fallback:true`）           |
| F10 | Phase 1 报告 §3 第 3 条原文：A6 的策略插话由**内核注册面**（`HookBus.register`）接进，"策略插件 → 插话总线"的装配链仍未接；§9 的回填清单把它列在第一位（并写明"Phase 2 动策略生态前必须回填"）                  | 本片就是这条回填项 ① 的兑现；报告与看板的表述要随之更新                                                      |
| F11 | `spawnCell` 给子进程的 `toolCallTimeoutMs = manifest.resources.toolCallTimeoutMs ?? 0`（`supervisor.ts` 130），而 policy 的 `resources` 必须是 `{}`                                                             | 策略舱没有"工具时限"这个量：链路的超时预算只能是 **HookBus 的 200ms**（契约 §7），不新增第二套时限数         |

## 3. 方案

### 3.1 B7①：策略插件 → HookBus 装配链（六步）

1. **装载面**：`packages/cell-runtime/src/policy-main.ts`（新进程入口）装载策略模块，只认一种导出：`export const hooks = { toolApproval: fn, stopAdvice: fn, … }`。不喂 `CellClient`、不喂任何主动接口（§3.3"无主动接口"）；装载门复用 ADR-0011（未登记完不应答，漏调 `markReady` 表现为就绪超时 = 可见失败）。
2. **新 op**：`policy.hook`（宿主→策略舱），载荷 `{ hook, round, input }`，应答 = verdict 原样。**校验仍留在 HookBus**（禁区校验是内核职责，挪进舱内等于让被审者自审）。
3. **接线**：`packages/host/src/policy-link.ts`：按报关单 `hooks` 白名单逐个 `bus.register(name, (input) => cell.conn.request("policy.hook", { hook: name, round, input }, timeoutMs))`；未声明的 hook **不注册**（无介入即无事件，`hooks.ts` 第 8 行既有口径）。**两份策略抢同一 hook → 装配期整份拒绝**（ADR-0012 决策 5）：`HookBus.register` 的"同名覆盖"从此只允许装配器在**已查重**的策略集合上调用——覆盖 = 后一份悄悄吃掉前一份的否决权，账本只看得到"有人说话"看不出说的是谁。
4. **时限与失败**：策略侧时限 = HookBus 的 200ms（契约 §7，F11）；超时/异常/舱退都走既有 fallback 路径并落 `HOOK_VERDICT{fallback:true}`——**不新增错误码**（与 ADR-0011 同一姿态）。
5. **交付入口**：`keel run --policy-manifest <path> --policy-module <path>`（可重复），`BuildRuntimeOptions.policies?: {manifest, modulePath}[]`。代码路径由宿主配置给出——**manifest 里没有代码路径字段**（报关单不指定实现，既定设计）。
6. **装配审计（已定，ADR-0012 决策 6）**：`ASSEMBLY_RECORDED` 增 `policies: [{name, version, hooks[]}]`——追加字段，Phase 1 旧账本样例仍可读（与 B7⑤ 的兼容口径一致）；契约 §5 随本片施工补一行注记。

### 3.2 B4：D 档的拒绝点与"零部分生效"核对法

| 尝试（样本要干的坏事）                          | 拒绝点在哪一期                         | 留痕怎么看                                                      | 零部分生效怎么证                                          |
| ----------------------------------------------- | -------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| 旧插件 `ctx.hooks.register("toolApproval", fn)` | 运行期（舱内，承接层映射）             | `TOOL_RESULT{status:"error", error.code:"ADAPTER/UNSUPPORTED"}` | 该 run 之后 `HOOK_CALLED` 计数 = 0                        |
| 工具返回体夹带 `{next:{tool,…}}` 想安排下一动作 | 运行期（调度器不解读工具结果，I1）     | 该轮只有一条被授权的 `TOOL_INVOKE/TOOL_RESULT`                  | 下一轮动作仍来自 driver 的可见表选择，插件字段无回响      |
| 插件内自建预算判断并"自行停止"                  | 运行期（预算唯一事实源在内核）         | `BUDGET_RESERVED/SETTLED` 与插件自报数字无关                    | 终态由内核决定，插件的 `suggestStop` 类返回不产生 `RUN_*` |
| `kind:"policy"` 的 manifest 带 `permissions`    | 装配期（五步第 1 步 schema）           | `keel validate --expect reject` 输出 + 无产物                   | **整份拒**，不做"只收合法那几项"的部分接受                |
| `hooks` 里出现白名单外的名字（如 `onToolCall`） | 装配期（同上）                         | 同上                                                            | 同一份里合法项也不生效（拒绝不可部分化）                  |
| 能力插件带 `hooks`（#2 拆支的 D 档一支）        | 装配期（capability 分支 `maxItems:0`） | 同上                                                            | 承接层侧另有 `ctx.hooks.*` 抛错兜住运行期                 |
| 策略响应夹带 `{verdict:"deny", nextTool:"x"}`   | 运行期（HookBus 禁区校验，F9）         | `HOOK_VERDICT{fallback:true}`                                   | 采纳的是默认策略，不是"合法字段照用 + 额外字段忽略"       |

"零部分生效"的机械核对（不是口头）：

- (a) 每枚样本的账本里，D 档能力对应的事件集合大小 = 预期（0，或仅 `fallback:true`）；
- (b) 扫描策略舱入口与承接层注入面：`run.` / `scheduler` / `ledger.append` / `budget.configure` / `hooks.register` **零命中**（内核命名空间不出现在插件可见参数里，契约 §3.3 的机械化）；
- (c) 五步校验对每份畸形 manifest 都是**整份拒绝**（错误码 + 无候选产物落盘），与切片②的"候选不自转正"同一纪律；
- (d) B5 符号扫描继续负责"旧 API 符号都有归属"，`hooks.register` 必须仍落在 `refused` 桶（新增进 `guide` = 谎报）。

## 4. 测试面与验收锚点

| 测试                                                     | 内容（断言要点）                                                                                                                                                                                                                                 | 锚定               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `packages/cell-runtime/test/policy-cell.test.ts`         | 入口只认 `export const hooks`；未声明的 hook 不调用；空表/非函数值装载期拒（与切片③ `ADAPTER/SHAPE-INVALID` 同姿态）                                                                                                                             | B7①（装载面）      |
| `packages/host/test/policy-link.test.ts`                 | 报关白名单 → 注册集合一一对应；超时/舱退 → `fallback:true` 且**没有任何 run 被 abort**（F7 的测试化）                                                                                                                                            | B7①、I2            |
| `tests/policy-chain-attribution.test.ts`                 | **真进程真实 run**：四 hook 逐条介入且可归因——deny 真的挡住工具（`TOOL_RESULT{error.by:"policy-hook"}`）、retry 真的重试且 ≤3 次、budgetExhaustedChoice 真的选到 `graceful`、stopAdvice 真的收束；每条 `DECISION.basedOn` 含对应 hook 的两个 seq | **B7①**            |
| `tests/cordis-d-tier.test.ts`                            | **B4 主战场**：上表七枚尝试的真进程复演 + 机械核对 (a)(b)(c)；一票否决场景，任何"悄悄生效"即整片不过                                                                                                                                             | **B4【一票否决】** |
| `tests/cordis-symbol-scan.test.ts`                       | `hooks.register` 仍在 `refused`；D 档样本里出现的每个 `ctx.*` 符号有归属                                                                                                                                                                         | B5 增量            |
| 现有 `hooks.test.ts` / `scheduler.test.ts` / A6 归因测试 | 不动，按 B8 复跑（合同 §6 风险 5 的守门就是这条）                                                                                                                                                                                                | B8                 |

## 5. 与切片①②③的接缝（不重做）

- 承接层对 `ctx.hooks.*` 的拒绝**不改**（切片①定的，手册 §8 写的就是"这条路不存在"）——本片只补真进程证据，不开新出口。
- 装载门与就绪凭据共用（ADR-0011）：策略舱的"舱真的能用"凭据仍是一次 `cell.snapshot` 应答（无快照面时回 `{state:null}`，仍是一次应答 = 装载完成），**不为就绪再加新 op**。
- 切片③的 `ctx.ledger.read` 已经让能力插件能看见本 run 的 `HOOK_*` 事实（策略说了话，被影响的插件自己可查）——本片不再开新面。
- 切片②的五步校验是 D 档两枚负样本的入口；`keel validate --expect reject` 已有退出码口径，本片直接复用。
- 手册 §8 那节的"证据由本片补"承诺在此兑现（合同 §6 风险 3 的处置）。

## 6. 体量、依赖与门禁影响

- 代码增量预估：`cell-runtime`（`policy.hook` 路由 + `policy-main` 入口）+~65；`host`（`policy-link` + supervisor 的策略舱位）+~50；`apps/keel`（CLI 两个参数 + `BuildRuntimeOptions.policies`）+~35；**`core` 零改动**（fallback 与留痕语义都是既有的）；最大实现文件仍是 `scheduler.ts` 569 行（红线 600）。
- 契约与协议：新增 **1 个宿主→舱 op**（`policy.hook`）+ `ASSEMBLY_RECORDED.policies` 追加字段 → **已立 [ADR-0012](../../adr/ADR-0012-policy-plugin-process-and-hook-op.md)**（策略舱执行位置与生命周期、op 载荷、失败语义、冲突整份拒、审计扩展；被否方案四条留在文内）。这是本片与切片③（零契约变更）最大的不同，也是 §7 第 1 项要交给所有者定的原因——三项均已确认。
- fixtures：策略样本 2 枚（正常一对 hook + 违规响应各一份）+ D 档尝试 3-4 枚 + 畸形 manifest 2 份；沿用 `tests/fixtures/cordis-plugins/` 的零改动机械判据与 `.prettierignore` 保护（新生态策略样本属 `tests/fixtures/`，不受该豁免）。
- 文档：本稿 + 01 稿 #7/#14 两行补实现期注记（追加式，不改档位）+ 05 手册 §8 证据行 + 契约 §4.8/§5 注记（若扩审计字段）+ ADR-0012。依赖：新增 0 个三方依赖。
- 门禁：六道 + `pnpm clean` 起全链一次；B8 复跑含 Phase 1 契约级五测试点与切片①②③验收组。

## 7. 所有者确认结果（2026-11-03，三项均按建议）

1. **策略插件代码跑在哪里 = 自己的进程（每 run 一个策略舱）**，并为此立 [ADR-0012](../../adr/ADR-0012-policy-plugin-process-and-hook-op.md)：
   - **选定：每 run 一个策略舱**（`policy.hook` 新 op + ADR）。理由 = F6 + I2：进程内 import 会让策略模块读到宿主内存与内核命名空间，契约 §3.3"除 hook 入参外的一切不可见"在接通当天就是谎话；进程边界也让策略崩溃与 run 崩溃分类各归各位。代价 = 每 run 多一个进程、每次插话一次跨进程往返（200ms 预算内，实测数量级毫秒）。
   - 被否 A：**宿主进程内动态 import**——零协议变更、最省事，但违反 §3.3 与 I2（一个忙等或抛错就带走宿主），且 B4 的"D 档硬拒绝"从此有反例。
   - 被否 B：**每宿主共享一个策略舱**——省进程数，但一次崩溃影响全部在途 run（策略舱没有归属 run 的 ref，退出时既不能 abort 也无从归因），且 run 间共享进程正踩 I2"无跨 Cell 共享可变接口"的边缘。
2. **两份策略声明同一个 hook = 装配期整份拒绝**：
   - **选定：整份拒绝**（明确错误码，不产候选、不注册）。`HookBus.register` 的注释写着"同名覆盖（装配器职责）"——覆盖就是静默改判：后一份策略悄悄吃掉前一份的否决权，账本里只看得到"有人说了话"，看不出说的是谁。
   - 被否：按声明顺序后者覆盖并在 `ASSEMBLY_RECORDED` 记被覆盖者；或第一个生效其余记缺项。两者都要额外定义"谁优先"的语义，且都要改账本载荷——比第 3 项的扩展更重。
3. **装配审计 = 补 `policies` 字段**（`ASSEMBLY_RECORDED` 追加，属契约 §5 载荷扩展，已记进 ADR-0012 决策 6）：
   - **选定：补**。F8 摆着——策略没插话时账本对它零记录，评审侧无法回答"这一轮究竟是谁的话、有没有话本该说而没说"；V6 的归因主张要的正是这个。扩展是**追加字段**（旧账本样例仍可读，B7⑤ 的兼容性口径不变）。
   - 被否：不补，只用 `HOOK_*` 事件反推——省一次契约注记，但"绑了却一次没说话"与"根本没绑"在账本上不可分辨。

## 8. 定稿后的落地清单（按序）

- [x] ADR-0012（策略舱执行位置与生命周期、`policy.hook` 载荷、失败语义、冲突整份拒、审计字段口径）
- [ ] `cell-runtime`：`policy.hook` 路由 + `policy-main` 入口 + 装载面单测（先红）
- [ ] `host`：`policy-link.ts`（白名单 → 注册集合 + 抢同一 hook 整份拒）+ 策略舱与 supervisor 的退出不级联证据
- [ ] `apps/keel`：`BuildRuntimeOptions.policies` + `keel run --policy-*`
- [ ] `ASSEMBLY_RECORDED.policies` + 契约 §5 注记
- [ ] 策略样本 + D 档尝试样本 + 畸形 manifest 2 份
- [ ] `tests/policy-chain-attribution.test.ts`（B7①）与 `tests/cordis-d-tier.test.ts`（B4）**先写红色断言**（铁律 7）
- [ ] 符号扫描判据扩展；01 稿 #7/#14 实现期注记；05 手册 §8 证据行
- [ ] B4 + B7① 验收；B8 复跑；体量核对 + 六道门禁（`pnpm clean` 起）；CHANGELOG / docs/README / CONTEXT / handoff 收尾四件事

## 9. 本片的限制（先登记，别等报告）

1. **策略舱在"后续再无 hook 调用"时崩溃仍不进账本**：fallback 只在真的被调用时留痕，崩溃本身只有 stderr。补了审计字段之后至少能分辨"绑了但没说话"与"根本没绑"，但"为什么没说"仍是 stderr 级信息。
2. **hook 入参含工具参数全文**（`scheduler.ts` 417 行的 `paramsDigest: action.params` 现在就是全文）——策略插件因此看得见参数。这属 §3.3 的字面（"hook 入参"），但"摘要"名不符实这件事要么另立回填项、要么改字段语义，本片**不顺手改**。
3. **多策略并存不做编排**：CLI 接一对或多对参数，但同 hook 冲突一律装配期整份拒绝（ADR-0012 决策 5）；优先级与链式组合属新生态（Phase 3）。
4. **策略舱没有工具时限这个量**（F11）：它不复用 `toolCallTimeoutMs` 的失控强杀宽限——策略进程忙等时，兜底只有 HookBus 的 200ms 超时 + 后续人工回收；物理强杀口径若要强化须与容器后端一起评（backlog）。
5. **`budgetExhaustedChoice` 的入参带本 run 预算视图**：策略因此能读预算（同属 hook 入参），但不构成新的读面。
6. **样本仍是合成写法**：真样本到位后按 01 稿 §5 义务回填；D 档零例外不因"存量插件普遍这么写"而开口子。
