# Phase 4 切片①设计稿 04：契约与 manifest 修订清单（含禁面扫描扩展）

- 状态：**定稿**（2026-11-04 起草 / 2026-11-04 所有者随 01~03 同批过闸；按本清单实施）
- 日期：2026-11-04
- 关联：设计稿 [01](01-profile-assembly.md) / [02](02-model-kind.md) / [03](03-engine-kind.md)；[ADR-0021](../adr/ADR-0021-session-ledger-topology.md)（已定稿）；[契约](../design/phase-1/01-core-api-contract.md) / [manifest 规范](../design/phase-1/03-plugin-manifest.md) / [schema](../design/phase-1/schema/keel-plugin.schema.json)；[禁面扫描器](../../scripts/scan-native-plugins.mjs) 与 [门禁测试](../../tests/native-plugin-scan.test.ts)

## 1. 这篇清单怎么用

01~03 的决策落到**有校验器/有测试/有账本**的地方，才有约束力。本文把每一处改动列成可勾选条目：改哪个文件、改什么、依据哪条设计。**没有列出的地方不改**；实施时发现清单外缺口 → 停下写 ADR 或记 backlog（范围纪律）。

## 2. 契约修订（`docs/design/phase-1/01-core-api-contract.md`）

| 编号 | 位置        | 变更                                                                                                                                                                                                                | 依据                                                              |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| R1   | §5 事件表   | **新增表面事件类型两条**：`TURN_INPUT`（run 起始的用户/系统输入，`role` 区分）与 `MODEL_MESSAGE`（模型回答正文 + 工具调用意图 + 用量引用 + **`reasoningContent?`**）。进账本、同 seq 序列、仅 Core 可写             | ADR-0021 决策 1/3；03 稿 E4；research/02 §3（思考内容必须可回传） |
| R2   | §5 注记     | `ASSEMBLY_RECORDED` 由"run 首事件"改为"run 启动时按 profile 声明序写入的首批事件"；载荷追加可选 `profile:{name,version}` 与 `plugin:{id}`                                                                           | 01 稿 P6；D1                                                      |
| R3   | §5 注记     | 表面事件白名单：只有 `TURN_INPUT` / `MODEL_MESSAGE` / `TOOL_RESULT` 进模型视图；`surfaceOp` 字段**预留、本阶段不实现**，只允许出现在表面事件上                                                                      | ADR-0021 决策 3/4；C2/C4                                          |
| R4   | §4.7 + §5   | `MODEL_USAGE` 载荷升 v3：追加 `usageBuckets:{inputCached,inputUncached,output}`、`tier:"peak"\|"offPeak"` 与 `pricedBy:"manifest"`；`cost` 由 Core 按 manifest 价格表计算（`kind:"model"` 路径不接受模块自报 cost） | 02 稿 M3（已确认）；research/02 §6/§7（三桶 + 峰谷两档）          |
| R5   | §4.7 注记   | 模型调用治理三层：总时限（既有 120s/300s）+ 模块空闲看门狗（可选，≤ 总时限）+ 单次实结超预扣不穿透预算（`overrun:true`，按既有耗尽处置）                                                                            | 02 稿 M5（已确认）；补 `budget.settle` 现状缺口                   |
| R6   | §4 接口定义 | **新增 Host→Cell op `engine.step`**：`{runId, step, maxSteps, messages, tools, lastResult?}` → `{decision:{kind:"act",actions[]}                                                                                    | {kind:"done",summary}}`；响应形状封闭；一步取 §7 的 300s 档       | 03 稿 E1（已确认）/E3 |
| R7   | §7 超时表   | `engine.step` 一行：取既有 300s 档，**不新增数字**                                                                                                                                                                  | 03 稿 E3                                                          |
| R8   | §6 错误码   | **不新增**：协议违规用 `RUN_FAILED{reasonCode:"ENGINE_PROTOCOL"}`、超步数 `MAX_STEPS`、舱退出 `ENGINE_EXITED`；装配/清单错误复用 `SCHED/MANIFEST-INVALID`                                                           | 01 稿 §5；03 稿 §6                                                |

## 3. manifest 修订（规范 + schema + 装配器）

| 编号 | 位置                                       | 变更                                                                                                                                                                                                                                                        | 依据                         |
| ---- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| R9   | `schema/keel-plugin.schema.json`           | `kind.enum` 扩为五值（+`model`、`engine`）；新增两段 `if/then`：`model` 必填 `model` 段、`engine` 必填 `engine` 段；`additionalProperties:false` 不变                                                                                                       | 01 稿 P7；02 稿 M1；03 稿 E9 |
| R10  | manifest 规范 §5.2                         | 能力词表**不增项**；补一条语义规则：`engine` 的 `permissions` 只允许 `model.adapter`，越界即整份拒绝（不靠评审）                                                                                                                                            | 03 稿 E8                     |
| R11  | manifest 规范 §5（新小节）                 | `model` 段字段表（provider/protocol/models/endpoint/auth.ref/pricing/timeouts.idleMs）；`pricing` 按模型分表，三桶 + `offPeak`/`peak`/`peakWindows`/`unknownTier`；`auth.ref` 为环境变量名，pattern 拒绝 `sk-` 形态；示例模型名取现行名（`deepseek-flash`） | 02 稿 §4；research/02 §1/§7  |
| R12  | manifest 规范 §5（新小节）                 | `engine` 段字段表（loop/model.ref/model.name/tools/maxSteps）；`tools` 每个名字装配期**恰好一个**能力插件提供，重名整份拒绝                                                                                                                                 | 03 稿 §4/E9                  |
| R13  | 装配器（`packages/host/src/assembler.ts`） | 新增语义校验：engine 能力白名单；`model.auth.ref` presence-only（缺失拒绝，错误只写 ref 名）；`pricing` 的键集合 = `models`、三桶非负有限、`peak` 存在时 `peakWindows` 必填、`unit` 只 `usd_per_mtok`；`timeouts.idleMs ≤ 总时限`；`maxSteps` 区间          | 02 稿 M6/M5/§4；03 稿 E9/R12 |

## 4. 禁面扫描扩展（K6；`scripts/scan-native-plugins.mjs` + 门禁测试）

按 **kind 分规则集**，不让一条规则误伤另一类插件：

| 规则 ID     | 目标 kind     | 判据                                                                     | 理由                                 |
| ----------- | ------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `E1-net`    | engine        | `node:http`/`https`/`net`/`tls`/`dgram` 的 import/require；裸 `fetch(`   | engine 禁直连出网（K6）              |
| `E2-env`    | engine、model | `process.env` 读取                                                       | 密钥只经注入解析面；engine 无密钥    |
| `E3-ledger` | engine        | `ledger.append` / `effect.declare` / `workspace.write` / `tool.register` | engine 无写账本与副作用入口（E2/C5） |
| `E4-hook`   | engine        | `policy.hook` / hook 注册面                                              | 被审者不能自审（I1）                 |
| `E5-key`    | 全部          | `sk-[A-Za-z0-9]` 形态字面量、`authorization` 头赋值                      | 密钥零出现（D4）                     |
| `M1-cost`   | model         | 模块导出返回值里出现 `cost` 字段（文本级判定）                           | 费用权威在 Core（M3）                |

配套改动：`REQUIRED_ROWS` 覆盖新规则；`tests/native-plugin-scan.test.ts` 的毒样本表按规则各加一条（红测先行）；真扫描零命中；扫描器对 `packages/plugins` 之外**不**扩大（model 模块若放在 `packages/plugins/model-*` 下天然被覆盖）。

## 5. 需要新写的 ADR（切片①收尾）

- **ADR-0022**：manifest kind 扩展（model/engine 两段的语义校验与能力封闭）。
- **ADR-0023**：`engine.step` 新通道（新增 Host→Cell op 的先例、形状封闭、300s 档）。
- **ADR-0024**：表面事件族（统一流的词汇、白名单、写权；`surfaceOp` 预留）。
- 三篇都写"被否方案"：分别是不扩 kind（塞进 capability）、engine 一次 run 到底、双日志（已被 ADR-0021 否决，引用即可）。

## 6. 实施顺序（过闸后）

1. R9~R13（schema + 装配器 + 规范）→ 门禁红测先写；
2. R1~R8（契约 + 事件 + 网关计价 + `engine.step`）；
3. §4 扫描规则 + 门禁测试；
4. 三篇 ADR 定稿；
5. 三份设计稿回填"实施注记"（与 Phase 3 同口径：只补事实，不改决策）。

> 实施注记（2026-11-04，切片①收尾）：第 3 步已落地——`scripts/scan-native-plugins.mjs` 增加 `E1-net` / `E2-env` / `E3-ledger` / `E4-hook` / `E5-key` / `M1-cost` 六条按 kind 生效的判据；kind 从插件目录的 `keel-plugin.json` 读取，读不到只跑全局规则（清单本身归装配期判死）。门禁测试补"判据齐全 + 逐条毒样本（带 kind 清单）+ 干净 engine/model 样本零命中"三组，全仓 56 文件 422 测试通过、实扫三件套零命中。第 4 步（三篇 ADR）同批完成（[0022](../adr/ADR-0022-manifest-kind-extension.md) / [0023](../adr/ADR-0023-engine-step-channel.md) / [0024](../adr/ADR-0024-surface-event-family.md)）。R1~R13 的代码实施仍归切片②③④。
>
> 实施注记（2026-11-04，切片②）：**R2 与 R9~R13 已落地**——manifest schema 扩五值 + model/engine 两段 `if/then`；装配器新增 `validateModel` / `validateEngine`（engine 能力白名单、`auth.ref` presence-only、价格表键集合与三桶/峰谷、`idleMs` 上限、`maxSteps` 区间）；profile schema + 严格 YAML 子集解析器 + 六步装配 + 逐插件装配记录（契约 §5 注记已按 R2 修订）。R1/R3~R8 仍归切片③④。`R13` 里"engine 工具恰好一个提供者"用**真实注册结果**在 profile 装配器复核（01 稿 §9）。
>
> 实施注记（2026-11-04，切片④）：**R6 / R7 / R8 已落地，清单 R1~R13 全部关闭**。① R6：`engine.step` 进 Cell 受理面（`packages/cell-runtime/src/cell.ts`），宿主 `SupervisedCell.stepEngine()` 走既有 `call`；响应形状封闭，另加一个**清单外实现细节** `message?`——模型正文必须回给 Core 才能写 `MODEL_MESSAGE`（表面事件只有 Core 能写）。② R7：一步时限取既有 300s 档（`ENGINE_STEP_TIMEOUT_MS`），不新增数字。③ R8：错误码零新增；`ENGINE_PROTOCOL` / `ENGINE_EXITED` / `MAX_STEPS` 都是载荷级 reasonCode，协议违规用"带 code 的结构化错误"落到 `RUN_FAILED{reasonCode}`。④ 清单外实现细节三项：`TOOL_RESULT` 追加可选 `toolCallId`（表面投影的关联键）、`RunManifest.turnInput`（`TURN_INPUT` 由调度器写）、`DriverDecision.basedOn` / `haltReason`（engine 的模型事件进归因、`MAX_STEPS` 走 `RUN_HALTED`）。⑤ 实施期修正：`CompensationExecutor` 在 profile 全家桶下改为合并全部 `ASSEMBLY_RECORDED` 权限（原先只读第一条，能力插件在后面的 profile 会让 `fs.remove` 必然升级），坑条 P-022。⑥ 证据：`tests/engine-kind-e2e.test.ts` 9 例、`engine-react` 包内 4 例、CLI 冒烟 1 例、扫描零命中。
>
> 实施注记（2026-11-04，切片③）：**R1 / R3 / R4 / R5 已落地，R6~R8 仍归切片④**。① R1/R3：`TURN_INPUT` / `MODEL_MESSAGE` 进事件表、载荷形状 + `SURFACE_EVENT_TYPES` 封闭白名单（`TOOL_RESULT` 为第三类）+ Core 侧写入函数；`surfaceOp` 只定形状、不实现。② R4：`packages/core/src/pricing.ts` 按桶/峰谷计价；网关 `registerModel({models, upstream, pricing})` 接受 profile 装配期的注册，`kind:"model"` 路径拒绝模块自报 cost、未注册模型名一律拒绝；`MODEL_USAGE` 升 v3。③ R5：非流式 120s 由网关强制（注入位只给测试）；`idleMs` 由模块按分片 rearm；`Budgeter.settle` 超预扣时把用量夹到限额并记 `BUDGET_SETTLED{overrun:true}`（`BUDGET_SETTLED` 升 v2，计量如实）。④ 修订清单外新增两项实现细节：**一份 profile 内同名模型 = 整份拒绝**（engine 只按名字调用，同名则上游不可判定）；**跨装配重绑**（同一宿主进程多次装配时，后装配者显式 `replace` 该模型名，避免测试/多 run 场景残留旧模块）。⑤ 两个实现落地：`packages/plugins/model-mock`（进 CI，6 单测 + 12 集成例）与 `packages/plugins/model-deepseek`（手动脚本 `scripts/verify-model-deepseek.mjs`，不进 CI；本次无密钥，未执行真实请求）。

## 7. 自检清单

- [ ] 新增事件类型仅 2 条、新增 op 仅 1 条、新增错误码 0 条
- [ ] 每条修订都能指回 01~03 的某个 P/M/E 编号
- [ ] 装配器语义校验与 schema 分工清楚（schema 管形状，装配器管语义）
- [ ] 扫描规则按 kind 生效，负样本齐全，零误伤既有三件套
- [ ] 没有顺手改与 Phase 4 无关的面（hook 词表、补偿语义、Cordis 边界表）
