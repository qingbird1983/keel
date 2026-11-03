# Phase 3：新插件生态（原生 manifest 标杆插件）

- 状态：**定稿**（2026-11-03 所有者确认四项开工决定，见 [ADR-0014](../adr/ADR-0014-drop-legacy-ecosystem-compat.md) 实施注记：首批插件选型 / 验收锚五不变量 / cordis 测试剥离门禁 / tag 已打。一经定稿即约束实现）
- 2026-11-03 修订（所有者要求）：切片计划插入**切片③ Cell-Runtime AOP + 内置补偿底座**（[04 稿](../design/phase-3/04-cell-runtime-aop.md) / [05 稿](../design/phase-3/05-builtin-compensation.md) / [06 DX 报告](../design/phase-3/06-dx-compensation-report.md)，均已定稿），原切片③（插件 B+C）顺延为④，原④（规范回填 + 验收）顺延为⑤；验收场景 C1~C7 不变。
- 2026-11-03 批准（所有者“通过，定稿开始实施”）：[07 稿](../design/phase-3/07-runtime-context-refactor.md) 转为定稿，D1~D6 按建议落定（[ADR-0017](../adr/ADR-0017-runtime-context-layering.md) / [ADR-0018](../adr/ADR-0018-effect-receipts-and-workspace.md) / [ADR-0019](../adr/ADR-0019-trust-tiers-and-cell-isolation.md)）；在切片④之前插入 **R1~R5 运行上下文重构**，插件 B/C 作为 R6 回到主线。
- 2026-11-03 完成：R1~R5 已实施（[ADR-0020](../adr/ADR-0020-workspace-error-codes.md) 为实施期新增）；`workspace.write` + 效果收据 + `ToolCatalog`/`PageStore` 拆分 + `setup/effect/dispose` + env/cwd/trust 全部落地，真进程证据见 07 稿 §13；下一片 = 切片④（插件 B/C，R6）。
- 2026-11-04 完成：**切片④（R6）完成，三件套闭环**——[08 稿](../design/phase-3/08-plugin-b-c.md) 定稿（K1~K5 所有者确认）：插件 B `file-write` 转正（纯 handler + `ctx.workspace`，C3 真进程补偿闭环 B-E1~E5 红测先行）、插件 C `param-guard` 转正（`toolApproval` 否决内容模式，C-E1~E4：归因 + 杀舱 fallback 不级联）；C2/C3/C4 达成（见 §5 打勾注记）；顺手修正 vitest include 缺层（插件包内单测进主线门禁）。
- 2026-11-04 完成：**切片⑤完成，阶段验收收口**——[阶段报告](../design/phase-3/report.md) 定稿：C1~C7 逐条复核全过（含三条一票否决）；规范回填复核（契约 §4.8 hook① 入参形状注记、manifest 稿 R4 生命周期导出面注记，均带日期、无 schema 变更）；插件开销基准 B6（治理满配 ~1ms、策略插话 0.2ms，只测不设阈值）。交付物齐备，`phase-3.end` tag 决定权归所有者。
- 日期：2026-11-03（起草与定稿同日；同日按所有者要求修订切片计划）
- 关联：[00-roadmap](00-roadmap.md) §1 看板；[ADR-0014](../adr/ADR-0014-drop-legacy-ecosystem-compat.md)（换轨决定 + 同日实施注记）；[design/phase-3/01-legacy-anti-patterns](../design/phase-3/01-legacy-anti-patterns.md)（**评审否决清单**）；[design/phase-3/02-review-mechanization](../design/phase-3/02-review-mechanization.md)（评审机械化口径 + 插件需求卡）；[design/phase-1/03-plugin-manifest](../design/phase-1/03-plugin-manifest.md)（manifest 规范本体）；[design/phase-1/01-core-api-contract](../design/phase-1/01-core-api-contract.md)（可见面矩阵与能力词表）；[architecture/01](../architecture/01-keel-overview.md) §6（原生插件模型）

## 1. 目标

为 Keel 原生 manifest 规范打造第一批"少而精"的**底层测试驱动型标杆插件**：Keel 当前只是运行底座，首批不选业务插件，而是选三个把内核主张钉在真进程证据上的最小插件——每个从一个明确的内核验证点出发、只做一件事、满足全部核心不变量（I1~I5），用真实进程证据证明"按规矩写的插件在 Keel 上是什么样子"。

## 2. 范围

### 做

- **首批标杆插件三件套**（选型所有者已定，需求卡见 [02 稿](../design/phase-3/02-review-mechanization.md)）：
  - **插件 A（只读工具）**：echo / fs-read 形态——验证授权与工具发现（工具只出现在声明的 scope、越权拒绝、装载门就绪凭据）
  - **插件 B（越界工具）**：file-write 形态——必须声明补偿模板，验证 `EFFECT_DECLARED` 与补偿闭环（注入故障 → 补偿执行 → 回滚有账本证据）
  - **插件 C（策略插件）**：拦截危险参数——验证 `policy.hook` 的介入与账本留痕（策略进程隔离、失败不级联）
- **Cell-Runtime 治理切面（AOP）与内置补偿底座**：manifest 新增 `governance` 声明（工具 → 权限守卫 / 副作用声明），宿主编译为治理计划随舱下发，Cell 在 handler 外自动完成 `auth.check`、`EFFECT_DECLARED` 与目标/摘要计算；常见撤销动作由宿主内建表承担（首版 `fs.remove`），record-only 用极简声明。handler 只留参数与业务，插件不写撤销代码（切片③，[04 稿](../design/phase-3/04-cell-runtime-aop.md) / [05 稿](../design/phase-3/05-builtin-compensation.md)）
- **评审流程机械化**：把 [反面教材清单](../design/phase-3/01-legacy-anti-patterns.md) §5 的五步评审落成可执行核查（原生插件**禁面**的符号扫描 + 每插件逐条留痕记录），见 [02 稿](../design/phase-3/02-review-mechanization.md)
- **manifest 规范实战检验**：三件套装配全程走既有五步校验；发现规范缺字段/歧义 → 登记并走 ADR 修订（不临场发明 API）
- **内核能力直接使用**：三件套作为 Phase 2 沉淀内核能力（注册通道、装载门、补偿、策略链）的第一批原生用户，替补被剥离的 cordis 测试覆盖
- **原生插件目录定案**：`packages/plugins/<name>/`（workspace 包，private、零三方依赖；不新增仓库根目录）

### 不做（明确排除）

- Cordis/DSH 旧生态兼容与迁移（已终止，ADR-0014；承接层归档、其测试已剥离主线门禁）
- 业务层插件与 Harness 业务场景（多 Agent 编排、UI 等）——**移 Phase 4 或 backlog**（所有者裁定：首批只做底层验证）
- 运行中提权、提示词贡献、自算预算、concludeTurn 等 18 类反面教材面（命中即退回，无"例外申请"）
- 三方运行时依赖（继承 Phase 1 起的零依赖纪律；插件自身同样遵守）
- 容器/microVM 隔离、分布式、账本存储引擎独立化、旁路计量（backlog 触发条件不变）
- 流式插件与观测生态：首批三件套都不调模型，流式记账场景**延后启用**（有真实模型插件需求时进本合同增补或 Phase 4）；跨 run 账本读取维持 backlog

## 3. 开工前置条件

- [x] **本合同定稿**：首批插件选型 / 验收场景取舍 / cordis 测试门禁归属三项均由所有者确认（2026-11-03，ADR-0014 实施注记）
- [x] **三件套需求卡**：[02 稿](../design/phase-3/02-review-mechanization.md) §4（每个插件一页：验证点、不变量锚、范围、验收口径）
- [x] **cordis 测试门禁归属**：已剥离主线（vitest exclude），文件与断言留库加归档横幅；内核命名测试（快照/流式/`throughSeq`/策略链）**保留在主线**（ADR-0014 实施注记 3）
- [x] 工具链 / 门禁 / 远端 / 许可证与署名（Phase 1 起就绪，无变化）

## 4. 交付物

| 类别 | 清单                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代码 | 三件套 `packages/plugins/{echo,file-write,param-guard}`（manifest + 实现 + 真进程测试）；Cell-Runtime 治理切面、宿主治理计划编译/校验与内置补偿注册表（`packages/cell-runtime` + `packages/host`）；切片③ AOP 真进程 fixture（`tests/fixtures/file-write-plugin`）；原生插件禁面扫描测试（`tests/native-plugin-scan.test.ts`）                                                                                                                                                                                                         |
| 文档 | [02 稿](../design/phase-3/02-review-mechanization.md)（评审机械化 + 需求卡）；[04 稿](../design/phase-3/04-cell-runtime-aop.md)（AOP 底座）；[05 稿](../design/phase-3/05-builtin-compensation.md)（内置补偿与 record-only 简化）；[06 报告](../design/phase-3/06-dx-compensation-report.md)（开发者体验对比）；[ADR-0015](../adr/ADR-0015-manifest-governance-and-cell-aop.md) / [ADR-0016](../adr/ADR-0016-builtin-compensation-registry.md)；每插件留痕记录（`REVIEW.md`）；manifest 规范修订（如有，走 ADR）；Phase 3 阶段进度报告 |
| 其他 | 反面教材清单的逐条留痕记录（每个插件"依据了哪几条、为何不适用"）；AOP + 内置补偿的改造前后对比与难度评估（04/06 稿）；基准复采（插件自身开销，只测量不设阈值）                                                                                                                                                                                                                                                                                                                                                                         |

## 5. 验收场景（定稿：只留验证五大不变量的条目）

> 标注【一票否决】的场景未通过时不得打 `phase-3.end` tag。每条注明锚定的不变量；凡不锚不变量的业务层场景一律不进本表。

- [x] **C1【一票否决】** 插件 A 授权与工具发现（**I1 控制 / I5 上下文**）：manifest 过五步校验零豁免 → 装载门就绪凭据 → 工具只出现在声明的 scope、跨会话互不可见；越权调用被授权器当场拒绝并留痕；真实进程 run 主场景跑通、账本完整
  > 2026-11-03 达成（切片②）：`tests/native-echo-e2e.test.ts` E1~E6 真进程（03 稿剧本）——五步校验零豁免、装载门就绪、scope 间工具表互不可见、`AUTH_DENIED` 落账本；2026-11-04 复核确认无回归（同文件随主线门禁持续运行）。
- [x] **C2【一票否决】** 反面教材零命中（**I1 / I4 / I5**）：禁面符号扫描对三件套机械核对零命中；每插件留痕"依据了哪几条、为何不适用"
  > 2026-11-04 达成（切片④）：`native-plugin-scan: clean`（echo/file-write/param-guard 三件全扫）；`REVIEW.md` ×3（02 稿 §5 五段：echo 切片②、B/C 切片④）。C2 的"每插件留痕"已齐，复核归切片⑤。
- [x] **C3【一票否决】** 插件 B 补偿闭环（**I4 副作用不可无痕 / I3 状态不可丢失**）：越界写先声明补偿 → `EFFECT_DECLARED` 留痕 → 注入故障 → 补偿按依赖序执行 → 回滚闭环有账本证据；**未声明的写当场拒绝、零部分生效**
  > 2026-11-03 口径补充（切片重排）：C3 的“先声明”由切片③ AOP 在 handler 之前自动完成；插件 B 代码零治理调用。切片③本身不替代 C3——C3 仍以插件 B 的真进程补偿闭环为准。
  > 2026-11-04 达成（切片④）：转正件 `packages/plugins/file-write` 真进程 B-E1~E5（红测先行，`tests/native-file-write-e2e.test.ts`）——B-E1 注入故障 → 内建 `fs.remove` 只删本次创建（收据 `created:true` + identity）→ `COMPENSATION_EXECUTED` 账本全链；B-E2 越界拒零部分生效；B-E3 重试幂等；B-E4 补偿只读账本可重放；B-E5 预存在目标 0 误删。“补偿按依赖序”由补偿状态机既有测试与 R4 多 effect 证据承担（fixture 机制样例保留，08 稿 §5 分工注记）。
- [x] **C4** 插件 C 策略介入可归因且不级联（**I1 / I2 故障不可级联**）：危险参数被策略插件拦截，介入逐条可从账本归因（承接 Phase 1 A6 口径）；策略进程崩溃只降级到既有 fallback，不级联 run
  > 2026-11-04 达成（切片④）：转正件 `packages/plugins/param-guard` 真进程联装（`tests/native-param-guard-e2e.test.ts`，C-E1~E4 红测先行）——C-E1 内容模式（guard 结构上看不到的面）deny + 介入 seq 进 `DECISION.basedOn` + handler 零执行；C-E2 放行不误伤；C-E3 kill 策略舱 → `HOOK_VERDICT{fallback:true}` run 照常推进；C-E4 未申领 hook 零介入 + `ASSEMBLY_RECORDED.policies` 记账。
- [x] **C5** 隔离与故障半径（**I2**）：注入插件崩溃，仅该 Cell 失败，其他会话不受影响（V2 延续）
  > 2026-11-04 复核达成：`tests/cell-crash.test.ts`（主线保留：崩溃舱 `RUN_FAILED{CELL/CRASH}`、并行会话正常收束、账本互不可见）+ R5 隔离证据（`packages/host/test/isolation.test.ts`：spawn 环境白名单、工作区 cwd；`tests/native-file-write-aop.test.ts` env/cwd 探针）。三件套均为普通 capability/policy 舱，走同一隔离边界，无特例。
- [x] **C6** 决策可重放（**I1 / V6**）：三件套任意 run 的决策序列可从账本重放（`throughSeq` 语义下，含策略介入的归因）
  > 2026-11-04 复核达成：`tests/audit-attribution-replay.test.ts`（①seq 连续归属单一终态收束 ②hook 成对留痕 ③授权拒绝归因齐备 ④`basedOn` 只引已发生事件且覆盖全部 hook 裁决 ⑤`keel replay` 输出归因行）+ `tests/decision-through-seq.test.ts`（直写事件在上界内、旧账本可读）；三件套语境的直接证据 = 切片④ C4 e2e 的介入归因断言（`attributed()`：`HOOK_CALLED`/`HOOK_VERDICT` seq 进后续 `DECISION.basedOn`）。
- [x] **C7** 质量与回归：六道门禁全绿；保留在主线的内核测试（快照/流式/`throughSeq`/策略链）与 Phase 1 A1~A8 主张不退化；三件套零三方运行时依赖机械核对（纪律项，随 C7 一并核）
  > 2026-11-04 复核达成：六道门禁全绿（56 文件 420 测试，Phase 1 主张的承载测试全数保留在主线：cell-crash / concurrent-scope-isolation / audit-attribution-replay / decision-through-seq / model-stream-channel / gateway-fail-closed / tool-failure-compensation / snapshot-cross-host 等）；零三方依赖 = 扫描器 B4-deps 机械判定（三件 package.json 零依赖字段）+ 零 import（B4-import）。

## 6. 依赖与风险

- 依赖：Phase 1~2 的内核能力（已全部在库并各有真进程证据）；Phase 2 合同 §8 保留物
- **风险 1：门禁剥离后的覆盖空窗**。`tests/cordis-*.test.ts` 剥离后，注册/装载门/补偿/策略链的 cordis 断言不再被门禁保护——替补是三件套的 C1/C3/C4（这正是"测试驱动三件套"的立项理由）。快照/流式/`throughSeq`/策略链归因的内核测试仍在主线，不受影响
- **风险 2：规范缺口临场发明**。manifest 规范没覆盖的诉求出现时，最危险的应对是插件自己想办法。缓解：缺口 → 登记设计稿 → ADR 修订 → 才实现（铁律 1 对插件同样生效）
- **风险 3：反面教材清单过期**。清单来自旧生态证据，可能漏掉新写法的坑。缓解：每接一个新插件回填清单（沿用 01 稿回填义务形状）；清单只增不改
- **风险 4：治理声明成为公开契约后漂移**。`governance` 是新的 manifest 面，一旦发布就要长期兼容。缓解：ADR-0015 定稿 + Schema 示例即 fixtures + 装配器语义校验；不引入表达式语言
- **风险 5：把 AOP 误当安全边界**。拦截器跑在插件自己的进程里，恶意插件仍可直接 IO。缓解：文档与评审口径明确“AOP = 治理代劳层，不是沙箱”；真正的边界仍是 Cell 隔离 + manifest 授权 + 人工评审
- **风险 6：保守声明导致“补偿不存在的东西”**。声明先于 handler，业务校验失败时可能没发生副作用。缓解：补偿动作必须容忍目标不存在（T06），切片③ e2e 覆盖该路径
- 估时：三件套均为最小插件，量级显著小于 Phase 2 任一切片；AOP 底座经评估为中等偏低（04 稿 §8，代码约 600~900 行含测试）；精确估时随设计定稿复核（不预设数字先行）

## 7. 切片划分（纵向切片，每片锚定验收场景）

| 切片 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 锚定场景            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| ①    | 合同定稿 + 评审流程机械化（禁面扫描测试先行 + 留痕口径）+ 三件套需求卡                                                                                                                                                                                                                                                                                                                                                                                           | C2、C7              |
| ②    | 插件 A 端到端（manifest → 装载门 → scope 授权 → 真进程 run）                                                                                                                                                                                                                                                                                                                                                                                                     | C1、C5、C6          |
| ③    | **Cell-Runtime AOP + 内置补偿底座**：manifest `governance` 声明 + 宿主治理计划编译/装载校验 + Cell 拦截器链（权限守卫 → 自动 `EFFECT_DECLARED` → 纯 handler → 治理上下文）+ 宿主内建补偿表（`fs.remove`）与 record-only 极简声明 + 负路径、真进程 fixture 与 DX 对比证据（[04 稿](../design/phase-3/04-cell-runtime-aop.md) / [05 稿](../design/phase-3/05-builtin-compensation.md) / [06 报告](../design/phase-3/06-dx-compensation-report.md)；ADR-0015/0016） | C7（机制）；C3 前置 |
| ③.5  | **运行上下文重构 R1~R5（已完成）**（[07 稿](../design/phase-3/07-runtime-context-refactor.md) §13）：R1 决策/ADR → R2 `@keel/runtime-context` 骨架与 `ToolCatalog`/`PageStore` 拆分 → R3 效果收据与受治理 Workspace（`wx` 创建、path/realpath、identity、`fs.remove` 只认收据）→ R4 生命周期/`toolCallId`/多 effect → R5 env 白名单/工作区 cwd/信任分层                                                                                                          | C3/C7 前置          |
| ④    | 插件 B（用新底座写纯 handler，补偿闭环）+ 插件 C（策略拦截）；R6 = 回到插件主线                                                                                                                                                                                                                                                                                                                                                                                  | C3、C4              |
| ⑤    | manifest 规范回填（含 `governance` 定稿，如有修订走 ADR）+ 阶段验收 C1~C7 复核 + 报告收口 + 基准复采                                                                                                                                                                                                                                                                                                                                                             | C1~C7 复核          |

> 每片开工前须有对应设计稿（`docs/design/phase-3/0N-*.md`）定稿——铁律 1；跨片超范围想法进 backlog 或另立 ADR。
>
> 2026-11-03 修订注记（所有者要求）：先把 Cell-Runtime 治理切面与内置补偿做出来再写插件 B；新增切片③，原③④顺延为④⑤。D1~D6 已按建议列定案，04/05 稿转定稿，ADR-0015/0016 已落笔；06 稿给出 file-writer 的 53 → 24 行 DX 证据。
>
> 设计稿对应：切片③ = 04 稿（AOP）+ 05 稿（内置补偿）+ 06 稿（DX 报告）；切片③.5 = 07 稿（运行上下文重构 R1~R5）；切片④ = 插件 B/C 设计稿（R6 回到主线时写，从 08 起编号）；切片⑤ = manifest 规范回填 + 阶段报告（不另立设计稿，修订直接落 manifest 稿/ADR）。
>
> 2026-11-03 批准注记：07 稿已定稿，R1~R6 进入实施；切片④/⑤ 顺延，插件 B/C 设计稿从 08 起编号。
