# Phase 4：全插件装配与最小业务闭环（Profile + model + engine，headless）

- 状态：**草稿**（2026-11-04 起草；待所有者逐行评审，§8 关键决策点 K1~K6 确认后转定稿。定稿前不写实现代码——铁律 1）
- 日期：2026-11-04（起草）
- 关联：[phase-3 合同](phase-3-native-ecosystem.md) §2 不做清单（业务层插件"移 Phase 4 或 backlog"的移交承接）；[research/01](../research/01-dsh-data-flow-survey.md)（DSH 数据流勘察——本合同全部设计输入的事实侧）；[ADR-0014](../adr/ADR-0014-drop-legacy-ecosystem-compat.md)（换轨决定）；[ADR-0015](../adr/ADR-0015-manifest-governance-and-cell-aop.md)（manifest governance 纪律，本合同沿用）；[契约](../design/phase-1/01-core-api-contract.md)（能力词表与可见面矩阵，本合同将修订）；[manifest 规范](../design/phase-1/03-plugin-manifest.md)（本合同将扩展两个 kind）

## 1. 目标

在 Phase 3 三件套验证过的治理基座上，长出第一批**业务层插件机制**，达成"愿景微缩闭环"：**一个 `profile.yaml` 拉起 `engine + model + capability + policy` 全家桶，Core 只做治理与装载**，跑通一个真进程、全治理、账本脊柱完整的 headless ReAct 闭环（mock 模型确定性剧本）。这一步之后，"万物皆插件"从主张变成可运行的事实——后续每个新 kind（ui 等）与业务插件都是同一装配面上的增量。

范围口径（所有者已确认的方向，2026-11-04）：按 DSH 的"逐步长"方式，本阶段只长 **Profile 装配面 + kind:"model" + kind:"engine"** 三件（headless 闭环）；会话持久化、桌面壳与 `kind:"ui"`、生态件（cookbook/脚手架）留后续阶段。**流向优先于结构**：每个 seam 的设计稿必须先钉死数据流向（谁发起、跨哪些边界、每跳账本记什么、谁有权读、坏了算谁的），再写结构。

## 2. 范围

### 做

- **Profile 装配面**：`profile.yaml` schema + Profile 装配器（复用既有五步校验；声明清单 → 逐插件拉起到各自隔离环境）；装配记录逐插件落账本（kind、隔离环境、scope 分配、就绪凭据）；profile 未声明的插件零加载
- **kind:"model"（manifest 第五类）**：Host 层驻留（持密钥，铁律 4 密钥红线）；manifest 面新定义（流式能力 / 计量口径 / 密钥引用 = 引用名非明文 / compat）；两个实现验证抽象——mock 适配器标杆（确定性剧本，进 CI）+ 一个真实 provider 适配器（直连 HTTP+SSE、第二实现验证抽象，手动验证不进 CI、不承诺生产可用）
- **模型流治理**：每次模型调用 usage 随结算事件落账本（分桶、绑 run/步序）；预算从账本投影 + 超限熔断；模型调用总超时/预算语义（DSH 无此项，Keel 自建）；流中途失败收束形态（interrupted / attempt / retry 全落账本）；密钥四层防护（per-request resolve / ref-only 诊断 / presence-only 配置面 / spawn env 白名单——R5 既有地基）
- **kind:"engine"（manifest 第二类）**：Cell 进程运行（I2 无特例）；最小 ReAct 循环标杆（单 Agent、单 run 多步：调模型 → 经治理通道调工具 → 结算 → 喂回 → 终结）；engine ↔ Host 协议（结算事件过界、工具调用经 Core 通道回流）；**engine 无特权**——禁面扫描扩展覆盖新 kind（engine 禁持密钥、禁直连网络出网、禁替换治理通道）
- **会话/账本拓扑 ADR（切片①必产）**：模型可见上下文与账本的拓扑决策（统一流 vs 双日志），压着 engine 的 run 内上下文装配——见 §8 K3
- **基准**：模型调用治理开销基准（延续 B6 形态，只测量不设阈值）

### 不做（明确排除）

- 跨 run 会话持久化、压缩（compaction）、fork/resume——下阶段（run 内上下文在本阶段范围内；run 结束即收束）
- 桌面壳 / `kind:"ui"` / 任何 UI 场景——后续阶段（本合同全 headless，验收不锚任何 UI 场景）
- 多 Agent 编排、subagent、agent 间通信——backlog（单 Agent ReAct 闭环后另立）
- 实时 delta 跨进程通道——设计上明确不做（research/01 结论 1：决策消费结算事件；delta 直达问题归后续 ui 阶段的 Host→桌面通道）
- 真 LLM API 进 CI——mock 为主；真适配器仅手动验证脚本
- 容器/microVM、分布式、账本存储引擎独立化——backlog 触发条件不变
- 流式插件观测生态的业务化——本阶段 usage 落账本即为启用点，观测面业务化留后续
- 补偿语义变更（file-write 已定不动）、策略 hook 词表扩展（无新需求不动）

## 3. 开工前置条件

- [ ] **本合同定稿**：§8 K1~K6 由所有者确认（两道闸第一道）
- [ ] **切片①设计稿定稿**（两道闸第二道）：三份设计稿（Profile 装配 / model kind / engine kind）+ 会话/账本拓扑 ADR + 契约修订清单
- [ ] Phase 3 收口：`phase-3.end` tag（所有者决定，不阻塞合同定稿；切片②开工前应已打）
- [ ] 工具链 / 门禁 / 远端 / 许可证与署名（继承，无变化）

## 4. 交付物

| 类别 | 清单 |
| --- | --- |
| 代码 | Profile 装配器（包归属进设计稿；预期 `packages/host` 或新 `packages/profile`）；manifest schema 扩展（kind enum + model/engine 两段 if-then）；mock 适配器标杆 + 真适配器（`packages/plugins/` 下，零三方依赖）；engine ReAct 标杆（`packages/plugins/` 下）；模型流结算/预算/超时的 Core 契约实现；禁面扫描扩展（新 kind 禁面）；基准新增段 |
| 文档 | 三份设计稿（`docs/design/phase-4/01-profile-assembly.md` / `02-model-kind.md` / `03-engine-kind.md`，编号从 01 起——每阶段独立目录）；会话/账本拓扑 ADR；kind 扩展 ADR（model/engine manifest 面）；契约修订（如有，走 ADR）；每插件留痕记录（`REVIEW.md`，禁面扫描扩展后三件套+新标杆全量重扫）；Phase 4 阶段进度报告 |
| 其他 | 设计稿必答问题逐条回答留痕（§6 清单）；真适配器手动验证脚本与记录（不进 CI）；DSH 对照差异的决策留痕（凡借"流的形状"处，设计稿写三栏：DSH 实况 / Keel 对应 / 差异理由） |

## 5. 验收场景（定稿：只留验证五大不变量的条目）

> 标注【一票否决】的场景未通过时不得打 `phase-4.end` tag。每条注明锚定的不变量；凡不锚不变量的业务层场景一律不进本表。

- [ ] **D1【一票否决】** Profile 装配与装配记录（**I1 / I5**）：`profile.yaml` 声明全家桶（engine + model + capability + policy）→ 装配器五步校验零豁免 → 逐插件拉起到各自隔离环境（Cell / 策略舱 / Host 模块）→ 装配记录逐插件落账本；profile 未声明的插件零加载；跨 scope 工具互不可见保持（C1 回归）；装配开销在基准段可见
- [ ] **D2【一票否决】** 模型调用计量与预算（**I1 / I3**）：engine 经治理通道发起的每次模型调用，usage 随结算事件落账本（input/output 等分桶、绑 run/步序）→ 预算从账本投影 → 注入超预算 → 下一跳调用被拒、熔断落账本、run 干净收束；无任何"未经落账的模型调用"路径（机械断言，非抽样）
- [ ] **D3【一票否决】** engine Cell 真进程闭环与故障半径（**I1 / I2**）：ReAct 标杆在独立 Cell 进程跑通多步"模型 → 工具 → 结算"循环（mock 确定性剧本；file-write 真写盘 + 补偿在环内）→ kill engine Cell → 在途模型调用与已声明 effect 收束、并行会话不受影响、账本完整（cell-crash 语义在 engine kind 上的延伸，teardown 参照 research/01 §2.1 阶梯）
- [ ] **D4** 密钥红线（安全红线）：机械扫描进门禁——密钥零出现于 manifest、账本、事件载荷、日志、engine Cell 环境（mock 用假密钥也守形状）；真适配器密钥仅存在于 Host 适配器模块的解析路径（per-request resolve）
- [ ] **D5** 决策可重放含模型调用归因（**I1 / V6**）：engine run 的每步决策（选哪个工具、为何终结）可从账本重放；模型调用事件与 hook 裁决进入 `DECISION.basedOn`（audit-attribution-replay 语义在 engine run 上的延伸）
- [ ] **D6** 流中途失败收束（**I3 / I4**）：注入流中途失败 → interrupted / attempt 收束形态落账本 → 部分输出不悬空 → 重试语义（retryable ∩ 上限）落账本可归因；**已发部分永不悬空**（research/01 §3 失败语义的 Keel 化）
- [ ] **D7** 质量与回归：六道门禁全绿；Phase 1~3 承载测试（三件套 e2e、cell-crash、audit-attribution-replay、throughSeq、快照跨主机等）零退化；新 kind 与标杆零三方运行时依赖机械核对（扫描器扩展后覆盖全部五类插件）

## 6. 设计稿必答问题（切片①设计稿须逐条回答并留痕）

> 来源：[research/01](../research/01-dsh-data-flow-survey.md) 勘察（对照材料 = "每一步的参照目标"）；编号沿用勘察速查表。

- **B1** engine ↔ 模型调用协议：请求/结算事件形状；压缩流记录要不要过界；engine（Cell 进程）发起模型调用与工具调用的通道形状（RPC over stdio？事件？）——D2/D3 的机制核心
- **B2** usage 落账的事件词汇与预算结算点（→ 契约修订）
- **B3** 模型调用总超时/预算语义（整调用预算，或 idle watchdog + 预算双保险）（→ 契约）
- **B4** kind:"model" 的 manifest 面声明什么；密钥红线落在 manifest 哪个字段（引用名而非明文）（→ manifest 修订 ADR）
- **B5** 流中途失败 × engine Cell 崩溃的联合收束（已声明未结算 effect、在途模型调用）（→ engine 设计稿）
- **C1** **会话日志与账本的拓扑**（统一流 vs 双日志）——本阶段范围内先回答 run 内形态，跨 run 形态留给下阶段但不堵路（→ 拓扑 ADR，预期本阶段最大决策）
- **C2** run 内事件词汇表首版（哪些进表面、engine/model/tool 各有权写什么）+ 写权纪律（→ 契约修订）
- **C3** 模型 dispatch 前持久化屏障的 Keel 语义（与账本 fsync 策略联动；ADR-0004 有界合并 checkpoint 是既有 backlog 重评条件）（→ 契约/账本）
- **C4** 表面投影纯函数的定义 + 表面操作（surfaceOp 形状）**预留**（本阶段不实现压缩，但词汇表必须预留形状，否则后补破坏事件兼容）（→ engine/契约设计稿）
- **C5** engine 插件写会话/上下文的防污染约束（research/01 §4 的 ignorable + 不可带表面操作机制的 Keel 对应物）（→ manifest/engine 设计稿）
- **C6** 压缩首版范围 = 不做；预留代价评估写进拓扑 ADR
- **D 面**（ui/桌面）本阶段不答，但 C1/C4 的设计**不得堵死**后续 D 面的路（投影、白名单、ready 先行——research/01 §5）

## 7. 依赖与风险

- 依赖：Phase 1~3 全部内核能力（装配门、Cell、账本、补偿、策略链、AOP、runtime-context、收据）；[research/01](../research/01-dsh-data-flow-survey.md) 作设计输入
- **风险 1：拓扑 ADR 悬置阻塞**。C1 是本阶段最大结构决策，拖后会让 engine 上下文装配返工。缓解：切片①先行，两道闸定稿后才写代码
- **风险 2：零三方依赖下真适配器可信度**。直连 HTTP+SSE（research/01 §3 的 DSH 模式）无 SDK 依赖可行，但缺乏生产历练。缓解：真适配器定位为"第二实现验证抽象"，mock 承载全部验收；生产可用性明确不承诺
- **风险 3：范围蔓延**（会话持久化/UI/多 Agent 的诱惑）。缓解：不做清单 + backlog 通道；验收表不锚业务场景
- **风险 4：模型流事件词汇成为公开契约后漂移**。缓解：沿用 ADR-0015 纪律——ADR 定稿 + Schema 示例即 fixtures + 装配器语义校验；词汇表一次定稿，修订走 ADR
- **风险 5：engine 权限过大变"地主"**。引擎可替换 ≠ 治理可替换：engine 只提供"循环怎么转"，每跳（模型调用/工具调用/记账/裁决）仍走 Core 通道。缓解：禁面扫描扩展 + D3 真进程断言 + hook 语义不开放
- **风险 6：密钥泄漏面扩大**（新增持密模块 + 新通道）。缓解：D4 机械扫描进门禁；env 白名单（R5）覆盖 engine Cell；mock 全程假密钥
- **风险 7：账本 fsync 压力**（模型结算事件频率高于既有事件）。缓解：C3 屏障语义进设计稿；有界合并 checkpoint 维持 backlog（ADR-0004 重评条件）
- 估时：不预设数字先行（沿用 Phase 3 口径）；切片②③④均为纵向切片，量级参照 Phase 3 各切片

## 8. 关键决策点（待所有者确认后定稿）

- **K1 范围**：本阶段 = Profile + model + engine（headless 闭环）；会话持久化/压缩、桌面壳与 ui kind、生态件留后续阶段
- **K2 engine 运行环境**：Cell 进程（brief 定稿说法；research/01 结论 1 证明可行——决策消费结算事件，无 delta 跨界需求；实时 delta 直达桌面归后续 ui 阶段）
- **K3 拓扑方向**：会话/账本拓扑 ADR 进切片①必产；两个候选——a) 统一流（模型可见上下文=账本表面投影，账本即唯一事实；重放天然、但账本体量与 fsync 压力大）；b) 双日志（账本=治理事实与归因，会话日志=载荷，跨日志 seq 引用 `basedOn`；账本轻、但跨日志一致性与重放复杂）。**设计稿须两案对比后给出建议，所有者拍板**（两道闸第二道）
- **K4 真适配器策略**：mock 进 CI 承载全部验收；真 provider 适配器为第二实现（直连 HTTP+SSE、手动验证、不进 CI、不承诺生产可用）；具体 provider 选型进设计稿
- **K5 模型调用治理**：总超时/预算为 Core 治理面（自建，DSH 反面参照）；具体语义（整调用预算 vs watchdog+预算双保险）进设计稿对比后定
- **K6 禁面扩展**：禁面扫描器覆盖 model/engine kind——model 禁把密钥写进 manifest/事件/日志；engine 禁持密钥、禁直连网络出网、禁替换治理通道；三件套+新标杆全量重扫

## 9. 切片划分（纵向切片，每片锚定验收场景）

| 切片 | 内容 | 锚定场景 |
| --- | --- | --- |
| ① | 合同定稿（K1~K6）+ 三份设计稿两道闸 + 拓扑 ADR + 契约/manifest 修订清单 + 禁面扫描扩展（K6） | D7（扫描器部分） |
| ② | Profile 装配面端到端：schema + 装配器 + 装配记录落账本；三件套改经 profile 拉起（回归 C1/C3/C4/C5） | D1 |
| ③ | kind:"model"：manifest 段 + mock 标杆 + usage 落账 + 预算熔断 + 超时语义 + 流失败收束 + 密钥红线扫描 | D2、D4、D6 |
| ④ | kind:"engine" + ReAct 标杆 + 全家桶 headless 闭环 + 阶段验收复核 + 报告收口 | D3、D5、D1~D7 复核 |

> 每片开工前须有对应设计稿定稿——铁律 1；跨片超范围想法进 backlog 或另立 ADR。切片②③顺序不可倒置（engine 依赖 model seam），②③与④之间按依赖串行。
