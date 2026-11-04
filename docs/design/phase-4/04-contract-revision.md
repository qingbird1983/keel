# Phase 4 切片①设计稿 04：契约与 manifest 修订清单（含禁面扫描扩展）

- 状态：**草稿**（与 01~03 同批过闸；过闸后按本清单实施）
- 日期：2026-11-04
- 关联：设计稿 [01](01-profile-assembly.md) / [02](02-model-kind.md) / [03](03-engine-kind.md)；[ADR-0021](../adr/ADR-0021-session-ledger-topology.md)（已定稿）；[契约](../design/phase-1/01-core-api-contract.md) / [manifest 规范](../design/phase-1/03-plugin-manifest.md) / [schema](../design/phase-1/schema/keel-plugin.schema.json)；[禁面扫描器](../../scripts/scan-native-plugins.mjs) 与 [门禁测试](../../tests/native-plugin-scan.test.ts)

## 1. 这篇清单怎么用

01~03 的决策落到**有校验器/有测试/有账本**的地方，才有约束力。本文把每一处改动列成可勾选条目：改哪个文件、改什么、依据哪条设计。**没有列出的地方不改**；实施时发现清单外缺口 → 停下写 ADR 或记 backlog（范围纪律）。

## 2. 契约修订（`docs/design/phase-1/01-core-api-contract.md`）

| 编号 | 位置 | 变更 | 依据 |
| --- | --- | --- | --- |
| R1 | §5 事件表 | **新增表面事件类型两条**：`TURN_INPUT`（run 起始的用户/系统输入，`role` 区分）与 `MODEL_MESSAGE`（模型回答正文 + 工具调用意图 + 用量引用）。进账本、同 seq 序列、仅 Core 可写 | ADR-0021 决策 1/3；03 稿 E4 |
| R2 | §5 注记 | `ASSEMBLY_RECORDED` 由"run 首事件"改为"run 启动时按 profile 声明序写入的首批事件"；载荷追加可选 `profile:{name,version}` 与 `plugin:{id}` | 01 稿 P6；D1 |
| R3 | §5 注记 | 表面事件白名单：只有 `TURN_INPUT` / `MODEL_MESSAGE` / `TOOL_RESULT` 进模型视图；`surfaceOp` 字段**预留、本阶段不实现**，只允许出现在表面事件上 | ADR-0021 决策 3/4；C2/C4 |
| R4 | §4.7 + §5 | `MODEL_USAGE` 载荷升 v3：追加 `usageBuckets:{input,output,...}` 与 `pricedBy:"manifest"`；`cost` 由 Core 按 manifest 价格表计算（`kind:"model"` 路径不接受模块自报 cost） | 02 稿 M3（已确认） |
| R5 | §4.7 注记 | 模型调用治理三层：总时限（既有 120s/300s）+ 模块空闲看门狗（可选，≤ 总时限）+ 单次实结超预扣不穿透预算（`overrun:true`，按既有耗尽处置） | 02 稿 M5（已确认）；补 `budget.settle` 现状缺口 |
| R6 | §4 接口定义 | **新增 Host→Cell op `engine.step`**：`{runId, step, maxSteps, messages, tools, lastResult?}` → `{decision:{kind:"act",actions[]}|{kind:"done",summary}}`；响应形状封闭；一步取 §7 的 300s 档 | 03 稿 E1（已确认）/E3 |
| R7 | §7 超时表 | `engine.step` 一行：取既有 300s 档，**不新增数字** | 03 稿 E3 |
| R8 | §6 错误码 | **不新增**：协议违规用 `RUN_FAILED{reasonCode:"ENGINE_PROTOCOL"}`、超步数 `MAX_STEPS`、舱退出 `ENGINE_EXITED`；装配/清单错误复用 `SCHED/MANIFEST-INVALID` | 01 稿 §5；03 稿 §6 |

## 3. manifest 修订（规范 + schema + 装配器）

| 编号 | 位置 | 变更 | 依据 |
| --- | --- | --- | --- |
| R9 | `schema/keel-plugin.schema.json` | `kind.enum` 扩为五值（+`model`、`engine`）；新增两段 `if/then`：`model` 必填 `model` 段、`engine` 必填 `engine` 段；`additionalProperties:false` 不变 | 01 稿 P7；02 稿 M1；03 稿 E9 |
| R10 | manifest 规范 §5.2 | 能力词表**不增项**；补一条语义规则：`engine` 的 `permissions` 只允许 `model.adapter`，越界即整份拒绝（不靠评审） | 03 稿 E8 |
| R11 | manifest 规范 §5（新小节） | `model` 段字段表（provider/protocol/models/endpoint/auth.ref/pricing/timeouts.idleMs）；`auth.ref` 为环境变量名，pattern 拒绝 `sk-` 形态 | 02 稿 §4 |
| R12 | manifest 规范 §5（新小节） | `engine` 段字段表（loop/model.ref/model.name/tools/maxSteps）；`tools` 每个名字装配期**恰好一个**能力插件提供，重名整份拒绝 | 03 稿 §4/E9 |
| R13 | 装配器（`packages/host/src/assembler.ts`） | 新增语义校验：engine 能力白名单；`model.auth.ref` presence-only（缺失拒绝，错误只写 ref 名）；价格表非负；`timeouts.idleMs ≤ 总时限`；`maxSteps` 区间 | 02 稿 M6/M5；03 稿 E9/R12 |

## 4. 禁面扫描扩展（K6；`scripts/scan-native-plugins.mjs` + 门禁测试）

按 **kind 分规则集**，不让一条规则误伤另一类插件：

| 规则 ID | 目标 kind | 判据 | 理由 |
| --- | --- | --- | --- |
| `E1-net` | engine | `node:http`/`https`/`net`/`tls`/`dgram` 的 import/require；裸 `fetch(` | engine 禁直连出网（K6） |
| `E2-env` | engine、model | `process.env` 读取 | 密钥只经注入解析面；engine 无密钥 |
| `E3-ledger` | engine | `ledger.append` / `effect.declare` / `workspace.write` / `tool.register` | engine 无写账本与副作用入口（E2/C5） |
| `E4-hook` | engine | `policy.hook` / hook 注册面 | 被审者不能自审（I1） |
| `E5-key` | 全部 | `sk-[A-Za-z0-9]` 形态字面量、`authorization` 头赋值 | 密钥零出现（D4） |
| `M1-cost` | model | 模块导出返回值里出现 `cost` 字段（文本级判定） | 费用权威在 Core（M3） |

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

## 7. 自检清单

- [ ] 新增事件类型仅 2 条、新增 op 仅 1 条、新增错误码 0 条
- [ ] 每条修订都能指回 01~03 的某个 P/M/E 编号
- [ ] 装配器语义校验与 schema 分工清楚（schema 管形状，装配器管语义）
- [ ] 扫描规则按 kind 生效，负样本齐全，零误伤既有三件套
- [ ] 没有顺手改与 Phase 4 无关的面（hook 词表、补偿语义、Cordis 边界表）
