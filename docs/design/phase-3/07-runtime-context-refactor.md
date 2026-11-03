# Phase 3 重构计划：受治理的运行上下文与效果收据

- 状态：**定稿**（2026-11-03 所有者批准“通过，定稿开始实施”；D1~D6 按 §10 建议值全部落定，见 ADR-0017/0018/0019；R1~R6 进入实施）
- 日期：2026-11-03
- 关联：[架构总览](../../architecture/01-keel-overview.md)；[04 AOP 稿](04-cell-runtime-aop.md)；[05 内置补偿稿](05-builtin-compensation.md)；[06 DX 报告](06-dx-compensation-report.md)；[Phase 2 边界表](../phase-2/01-cordis-migration-boundary.md)（反面教材）；[ADR-0014](../../adr/ADR-0014-drop-legacy-ecosystem-compat.md)；[ADR-0017](../../adr/ADR-0017-runtime-context-layering.md) / [ADR-0018](../../adr/ADR-0018-effect-receipts-and-workspace.md) / [ADR-0019](../../adr/ADR-0019-trust-tiers-and-cell-isolation.md)；Cordis 核心源码（见 §12 来源）

## 1. 为什么需要这次重构

切片③证明了“治理可以自动织入”，也暴露了更根本的问题：

- AOP 能自动写 `EFFECT_DECLARED`，但**不知道 handler 真正做了什么**；
- `fs.remove` 按声明路径删除，**没有“文件是本次新建”的凭证**；
- `guard` 查 `params.path`，handler 可以写另一个位置——它是咨询性检查，不是安全边界；
- 路径匹配是字面 glob，`..`、符号链接、Windows 盘符/UNC 都可能让“允许的路径”和“实际读写的路径”不一致；
- 多个 effect 先全部声明、再执行，部分失败会把没发生的效果也拿去补偿；
- 工具重试每次生成新 `effectId`，跨 attempt 幂等没有载体。

这些不是靠再加几条校验能补上的。根因是：**我们把 Cordis 的“进程内 effect 清理”思路，直接套到了外部副作用上**。Cordis 的 effect 能清理它自己创建的资源；它无法证明一个外部文件是不是本次创建的，更无法撤销已经发出去的请求。Keel 需要的是另一种原语：**受治理的能力 + 效果收据 + 持久补偿**。

## 2. Cordis 调查结论：留下什么，不留下什么

Cordis 的核心不是“万物皆插件”，而是四个机制（源码见 §12）：

1. **Context 服务树**：`ctx` 是 Proxy；读服务时沿 fiber 父链 `locate`，未声明 `inject` 直接抛错；`ctx.isolate` 支持同名服务的多实例隔离。
2. **Fiber 状态机**：每个插件实例有 `PENDING → LOADING → ACTIVE → FAILED → UNLOADING → DISPOSED`；依赖缺失时等待，服务变化时自动重载/卸载。
3. **effect 清理栈**：`ctx.effect`、`ctx.on`、`ctx.plugin`、`Service` 注册全部挂到 fiber 的 disposer 栈，按逆序清理；父插件卸载等依赖者先卸载。
4. **事件与服务生命周期**：`emit/parallel/serial/bail/waterfall`；配置校验；服务拦截与热替换。

**值得留下的**：Context 树 + 显式依赖、Fiber 式节点状态、资源 effect 的逆序清理、作用域隔离、`waterfall` 中间件、Host 层热替换。

**不能照搬的**：环境式服务定位器（`ctx.xxx`/`ctx.get`）、依赖变化自动重载（会重放副作用）、把 effect 当外部补偿、插件提供任意服务/改全局、进程内单点、无账本/预算/授权/持久化。

一句话：**Cordis 提供“空间上的服务组合 + 时间上的资源清理”；Keel 要在此之上加“治理上的能力、账本与补偿”。**

## 3. 安全哲学：Rust 的类比与“度”

Rust 的安全不是免费的：生命周期、所有权、借用检查换来了编译期可证明的内存安全，也把一部分开发者挡在门外；`Rc<RefCell>` 和 `unsafe` 是对“有些场景无法或不该用纯 safe 表达”的承认。这个逻辑对 Keel 成立，但有一个关键差异：

> Rust 的安全是**编译期、局部、可证明**的；Keel 面对的是**运行期、跨进程、外部世界**的副作用，无法证明，只能约束、记录、收据、补偿。所以不能照抄 Rust 的严格，而要抄它的**分层**。

| Rust                     | Keel 对应                                             | 说明                                           |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------- |
| safe 代码 / 借用检查     | 受治理能力（workspace/model）+ 装配校验 + 收据 + 账本 | 默认路径，尽量让作者无感                       |
| `Rc<RefCell>` 运行时检查 | `record-only` / 插件自定义补偿                        | 承认有些事无法静态表达；运行时承担，但必须显式 |
| `unsafe` 块              | 受信插件的 raw IO 能力                                | 显式、局部、可审计；三方插件默认不开放         |
| `#[deny(unsafe_code)]`   | 三方插件禁用 raw IO                                   | 默认拒绝，但保留受控例外                       |
| 编译错误                 | 边界处 fail-closed + 明确错误码                       | 可见失败，不静默降级                           |
| 生命周期标注的复杂度     | 不引入表达式语言/不强迫写假 undo                      | 避免“安全税”压垮 DX                            |

四条原则：

1. **安全路径必须比不安全路径更短**。如果一个纯工具也要写十行治理，作者一定会绕开。
2. **风险分级，而不是一刀切**。纯计算零检查；可逆写自动收据；不可逆/越界才需要策略或人工；raw IO 只给受信方。
3. **检查必须绑定真实 IO**。查一个字段、写另一个地方的 guard 不是安全，是文档。不能执行的检查不要宣称是边界。
4. **逃生舱必须显式、可审计、有代价**。`record-only` 不是漏洞，是合法出口；`unsafe` 式的 raw IO 要有信任层级、审计和评审，且不享受 builtin 补偿。

“度”的可量化目标（作为 R1~R5 的验收指标）：

| 场景               | 额外概念                | 人工审批        | 代码胶水         |
| ------------------ | ----------------------- | --------------- | ---------------- |
| 纯计算/只读工具    | 0                       | 0               | 0                |
| 工作区新建文件     | 1 个能力（workspace）   | 0               | handler 5 行以内 |
| 覆盖写/越界写      | 1 个显式模式            | ≤1 次（按策略） | 0 撤销代码       |
| 不可逆外部动作     | 1 个 `record-only` 声明 | 0 或按策略      | 0 撤销代码       |
| raw IO（受信插件） | 1 个 trust 授权         | 装配期评审      | 自行负责         |

目标是 **0 次误删、0 次绿/黄路径审批、100% 红路径可归因**；不是“所有操作都要审批”。

## 4. 目标与非目标

**目标**

- 用两层 Context 承载“Host 可组合、Run 可确定”；
- 用能力句柄替代 `ctx.client` 全量暴露，让安全路径成为最短路径；
- 双效果栈：资源清理（Cordis 式）与业务补偿（Keel 式）分离；
- 效果收据：内置补偿只作用于“确实发生、身份可核对”的操作；
- 插件生命周期：`setup/ready/dispose`，Run 期冻结，Host 层热替换在 Run 边界；
- 重试幂等：`toolCallId` 贯穿 tool.exec / 账本 / effect；
- 信任分层：一方/三方、raw/mediated 的摩擦度不同；
- 保持现有 376 测试与 echo/归档适配层兼容。

**非目标（本轮明确不做）**

- 不恢复 Cordis/DSH 兼容（ADR-0014 已定）；
- 不做通用 DI 容器/任意字符串服务；
- 不做完整容器/microVM 沙箱（Node 权限模型也不是安全边界）；
- 不做网络请求的通用撤销、`fs.restore`、递归删除；
- 不把 Agent Loop、多 Agent 编排、UI 插件塞进本次重构（Phase 4）；
- 不引入 JSONPath/表达式/条件声明语言；
- 不在本稿写实现代码（R1 只落决策；R2 起另见实施记录）。

## 5. 核心设计（草案）

### 5.1 两层 Context

```text
Host Context（长期、可热替换）
  └─ Session Context（scope）
      └─ Run Context（每 Run 一份，运行期冻结）
          ├─ Capability handles（workspace / model / ledger / effects）
          ├─ Resource EffectScope（disposer 栈，LIFO）
          └─ Business EffectScope（intent / receipt / compensation）
```

- **Host Context**：插件装配、能力依赖、服务节点状态、Host 层热替换（Run 边界生效）。
- **Run Context**：Run 启动时从 Host 快照能力与授权；Run 期间不换服务、不热重载，保证可重放与可补偿。
- **能力句柄**：插件拿不到任意 `ctx.foo`，只拿到被授予的 `ctx.workspace` / `ctx.model` / `ctx.ledger` / `ctx.effects` / `ctx.logger`；未授予 = 访问即错（fail-closed）。
- **依赖声明**：`uses` 只允许封闭能力名；不是字符串服务注册表。缺失能力 = 插件 PENDING/拒绝装配，而不是运行到一半才炸。

### 5.2 双效果栈

| 栈          | API                   | 生命周期               | 是否进账本       | 典型用途                          |
| ----------- | --------------------- | ---------------------- | ---------------- | --------------------------------- |
| 资源 effect | `ctx.effect(cleanup)` | 节点卸载时 LIFO        | 否（可选轻审计） | watcher、定时器、stream、临时句柄 |
| 业务 effect | `ctx.effects`         | Run/工具调用边界；持久 | 是               | 写文件、外发请求、外部 API        |

**不要混用**：资源 effect 不能替代外部补偿；业务 effect 也不能拿来管内存资源。

业务 effect 的流程改为 **intent → receipt → settle**：

1. 能力操作在动手前写 intent（写前声明，保留“先声明后动手”不变量）；
2. 操作成功返回 **receipt**（是否原本存在、创建/覆盖、路径、identity、前后摘要）；
3. 只有 receipt 证明“本次创建且身份匹配”的效果，才允许 builtin 补偿；
4. handler 失败时只补偿**已执行、带 receipt** 的操作；
5. 覆盖写默认不启用 builtin 删除；走 `record-only` 或未来的 `fs.restore`；
6. 原始 IO（未走能力）没有 receipt → 不享受 builtin，必须 `record-only` 或自定义补偿。

### 5.3 效果收据（草案）

```ts
interface EffectReceipt {
  opId: string;
  kind: string;
  target: string; // 规范化后的绝对路径/资源标识
  existed: boolean;
  created: boolean;
  overwritten: boolean;
  identity?: { dev: string; ino: string }; // 平台可用的文件身份
  before?: { size: number; hash: string; mtimeMs: number };
  after?: { size: number; hash: string; mtimeMs: number };
  workspaceRoot: string;
  timestamp: number;
}
```

关键规则：

- **创建**用 `O_EXCL` 语义（Node `wx`），已存在即失败；成功 receipt 的 `created:true` 是 builtin 删除的唯一凭据。
- **覆盖**必须显式 `mode:"overwrite"`，receipt 带 `before`；builtin 不删除，除非未来提供 `fs.restore`。
- 删除前重新核对 `identity`/`after`；不匹配 → 升级/告警，不删。
- 路径先 `realpath` 父目录、拒绝 `..`/符号链接逃逸/越界/设备文件；Windows 盘符、UNC、大小写按平台规则归一。
- 多 effect：每个操作独立 receipt；未执行的效果没有 receipt，不进入补偿。
- 重试：`toolCallId` 复用；同一 call 的 effect 去重，不重复创建/删除。

### 5.4 生命周期

- 插件入口从“只导出 `tools`”扩展为可选 `setup(ctx)`：
  - `setup` 内用 `ctx.effect` 注册资源清理；
  - `ctx.tools.register` 仍可用，旧的 `export const tools` 保持兼容；
  - `ready` 表示静态工具注册/发布完成；`dispose` 由 Host 在 Run 终态或换绑时调用。
- Host 节点状态：`PENDING / LOADING / ACTIVE / FAILED / UNLOADING / DISPOSED`（可观测，不进业务账本或只进轻量审计）。
- **Run 期冻结**：Run 开始后不响应服务替换；Host 热替换只在新 Run 或轮边界后生效。Cordis 的自动依赖重载不搬进 Run。

### 5.5 信任与安全路径

| 路径                 | 默认策略                                            |
| -------------------- | --------------------------------------------------- |
| 绿：纯计算/只读      | 工具授权后放行，不加声明/审批                       |
| 黄：受治理可逆写     | 能力句柄自动收据 + 自动补偿，不审批                 |
| 红：覆盖/越界/不可逆 | 显式模式 + 策略/人工（按风险），无 builtin 假撤销   |
| 黑：raw IO           | 仅受信插件；显式 trust 授权、审计、评审；无 builtin |

隔离加固（R5）：

- spawn 使用 **sanitized env 白名单**（不继承宿主全部环境变量）、workspace cwd；
- 资源限制（内存/CPU/工具调用次数）接入 IsolationProvider；
- Node `--permission` 只作纵深防御（官方明确它不防恶意代码、符号链接可逃逸、Worker 不继承权限），不宣称沙箱；
- 不可信三方插件最终仍需 OS 用户/容器/网络命名空间；本阶段先登记 backlog，不假装解决。

## 6. 包与模块改动

| 包                               | 改动                                                                                                                                                    | 说明                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **新增 `@keel/runtime-context`** | Context 树、Scope、Capability 类型、EffectScope、节点状态                                                                                               | 零依赖；Host/Cell 共用类型，不做 IO/授权裁决        |
| `@keel/core`                     | `ContextManager` 改名/拆分（`ToolCatalog` + `PageStore`）；效果收据/`toolCallId` 类型                                                                   | 释放 “Context” 命名；账本可选追加字段，不新增事件族 |
| `@keel/cell-runtime`             | `setup(ctx)` 生命周期；`ctx.effect`；`ctx.workspace`/`ctx.model`/`ctx.effects` 句柄；旧 `tools` 兼容                                                    | `cell.ts` 需拆分，保持单文件 ≤600 行                |
| `@keel/host`                     | `workspace.ts`（受治理 fs + receipt）；`compensator` 只对带 receipt 的 builtin 生效；`assembler` 增加 `uses`/trust（可选）；`supervisor` env/cwd/limits | `fs.remove` 在 R3 前应视为实验能力                  |
| `@keel/cordis-adapter`           | **不动**                                                                                                                                                | 归档证据；只作为“不要做什么”的对照                  |
| `apps/keel`                      | fixture/CLI 迁移；Run 边界热替换                                                                                                                        | 不引入 Agent 编排大改                               |

## 7. 重构切片（R1~R5）

> 建议插在插件 B/C 之前：插件 B/C 应该成为新底座的第一批用户，而不是建在已知有洞的 AOP 上。

| 切片                          | 内容                                                                                        | 关键产物                                                          | 验收锚                                  | 依赖       |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------- | ---------- |
| **R1 决策与 ADR**             | 定 Runtime Context 边界、Effect Receipt 契约、信任分层                                      | 2~3 份 ADR + 本稿定稿；不改代码                                   | 决策表 D1~D6 全部落定                   | 所有者拍板 |
| **R2 Context 骨架**           | 新增 `@keel/runtime-context`；`ContextManager` 改名/拆分；Host/Cell 接类型                  | Context 树、Scope、EffectScope（资源）、节点状态；行为零变化      | 现有 376 测试全绿；隔离/LIFO 新测试     | R1         |
| **R3 收据与 Workspace（P0）** | `workspace.create/overwrite`、receipt、路径归一/符号链接/身份核对；`fs.remove` 只认 receipt | 关闭误删/覆盖/`..`/部分失败；file-writer fixture 迁移             | 误删=0；无 receipt 不删；覆盖不 builtin | R2         |
| **R4 生命周期与事务/幂等**    | `setup/ready/dispose`；Run 冻结；intent→receipt→settle；`toolCallId`；probe/retention 处置  | 插件节点状态机；重试同 call 不重复 effect；多 effect 只补偿已发生 | 生命周期/重试/部分失败测试              | R3         |
| **R5 隔离与信任**             | env 白名单、cwd、资源限制、Node permission audit；trust tier/raw IO 授权                    | 受信/三方分层；绿黄零审批、红路径可归因                           | 环境不继承、越界拒绝、审计齐全          | R4         |
| **R6 恢复插件线**             | 插件 B/C 用新底座补 C3/C4；manifest 回填、Phase 3 报告、基准                                | 三件套闭环                                                        | C1~C7 + 六道门禁                        | R5         |

估时（单人、专注会话，量级）：R1 0.5~1；R2 1~2；R3 2~3；R4 2~3；R5 1~2；R6 2~3。合计约 **8~14 个专注会话**，不含 UI/多 Agent。

## 8. 验收指标

**功能与安全**

- 预存在文件/覆盖写：builtin 不删除；补偿只作用于 `created:true` 且 identity 匹配的文件。
- 路径：`..`、符号链接目录、越界、Windows 盘符/UNC 用例全部拒绝或升级，不静默删除。
- 多 effect 部分失败：未执行的效果不被补偿。
- 重试：同一 `toolCallId` 不产生重复 effect/重复删除。
- 隔离：Cell 不继承宿主完整 env；cwd = workspace；受治理路径外写入拒绝；raw IO 只对受信插件开放。
- 绿/黄路径 0 审批；红路径 100% 账本可归因；误删为 0。

**DX**

- `file-writer` 仍保持纯 handler（目标 ≤5 行业务），0 撤销代码、0 auth 调用。
- 纯工具插件 0 额外概念；新插件模板 ≤10 分钟跑通。
- 旧 echo 与归档适配层测试不改语义。

**门禁**

- 每个切片：format / lint / typecheck / build / test / check-size；新增代码单文件 ≤600 行、文档 ≤500 行。
- 关键路径先用真进程/真文件测试（红测先行，P-007）。

## 9. 风险与缓解

| 风险                                 | 缓解                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| 范围失控，做成“完整 Cordis”          | 非目标写明；只做 Context/Effect/Lifecycle，不做通用 DI/HMR 全量 |
| 安全税过重，开发者绕开               | 绿黄零审批；safe path 最短；用 §3 的摩擦指标验收                |
| 收据要求导致 raw IO 插件失去 builtin | 明确这是设计：raw IO 本来无凭证；给 record-only/自定义补偿出口  |
| `EFFECT_*` 账本字段扩展破坏旧账本    | 只追加可选字段，读取缺省兼容；旧账本按 plugin 读（已有先例）    |
| Node permission 被误当安全边界       | 文档与评审明确“安全带”；不可信插件仍靠 OS/容器                  |
| Run 期热替换破坏确定性               | Run Context 冻结；Host 热替换只在 Run 边界                      |
| 迁移波及现有测试/fixture             | R2 行为零变化；R3 起逐片迁移，每片全量回归                      |
| 性能开销                             | 收据/路径核对只在边界；基准确认，不设未经验证的阈值             |

## 10. 待所有者拍板（D1~D6）

| #   | 问题                                                   | 建议                                                                          |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| D1  | Runtime Context 放新包，还是塞进 `cell-runtime`？      | **新包 `@keel/runtime-context`**（零依赖、Host/Cell 共用；避免 cell.ts 膨胀） |
| D2  | 效果收据是扩展 `EFFECT_*` 可选字段，还是新增事件类型？ | **优先扩展可选字段**；只有确实需要独立生命周期时才新增事件（须 ADR）          |
| D3  | trust 层级放 manifest 还是宿主策略？                   | manifest **申请**、宿主**授予**；三方默认 raw IO 拒绝                         |
| D4  | 一方插件 raw IO 默认允许还是也走能力？                 | **默认走能力；raw 作为显式受信例外**，避免“一方也失控”                        |
| D5  | R1~R5 插在插件 B/C 之前，还是之后？                    | **之前**；插件 B/C 是新底座第一用户，避免返工                                 |
| D6  | Node permission 用 audit 还是 enforce？                | **先 audit 收集差异，再对受信 Cell enforce**；不宣称沙箱                      |

## 11. 自检清单

- **铁律 1**：本稿先于实现；R1 决策阶段零代码，R2 起按切片实施。
- **铁律 3**：收尾四件事随会话归档（CONTEXT / handoff / 沉淀 / 体量）。
- **铁律 5**：范围只覆盖运行上下文与效果收据；插件 B/C、UI、多 Agent 不在本片。
- **铁律 7**：R3 起先写“误删/覆盖/部分失败”的失败测试，再实现。
- **I1**：授权/预算/账本仍在内核；能力句柄不替代 Authorizer。
- **I2**：效应失败不级联；资源清理与业务补偿分开。
- **I3**：收据/账本可重放；Run Context 冻结。
- **I4**：业务 effect 必须有收据或显式 record-only，不再“无痕”。
- **I5**：能力按 Run/Scope 隔离，无全局服务定位器。

## 12. 来源（Cordis 调查）

- [Cordis repository](https://github.com/cordiverse/cordis)
- [Context](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts) / [Fiber](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts) / [Service](https://github.com/cordiverse/cordis/blob/main/packages/core/src/service.ts) / [Events](https://github.com/cordiverse/cordis/blob/main/packages/core/src/events.ts)
- [Cordis paper: A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512)
- [Node.js Permission Model](https://nodejs.org/api/permissions.html)

## 13. 实施记录（2026-11-03，R1~R5）

### R1 决策与 ADR

- [ADR-0017](../../adr/ADR-0017-runtime-context-layering.md)：新增零依赖 `@keel/runtime-context`；Host/Run 两层 Context；能力句柄；Core `ContextManager` 拆为 `ToolCatalog` + `PageStore`。
- [ADR-0018](../../adr/ADR-0018-effect-receipts-and-workspace.md)：intent → receipt → settle；`EFFECT_SETTLED.receipt` 可选字段；`workspace.write`；`fs.remove` 只认收据。
- [ADR-0019](../../adr/ADR-0019-trust-tiers-and-cell-isolation.md)：绿/黄/红/黑路径；manifest 申请 trust、宿主授予；spawn 环境白名单与工作区 cwd；Node 权限模型仅可选纵深防御。
- [ADR-0020](../../adr/ADR-0020-workspace-error-codes.md)：`WORKSPACE/EXISTS` / `WORKSPACE/PATH` / `WORKSPACE/IO` 三码（实施期新增的决策，原计划未列）。
- 07 稿定稿；契约 §4.6/§5/§6/§7 带日期注记；manifest 稿补 `trust` 与 R3 注记。

### R2 Context 骨架

- 新包 `packages/runtime-context`：`Scope/RunRef/scopeKey`、`RunNodeState`、`EffectScope`（LIFO/异步/幂等/错误聚合）、`RunContext`（冻结身份与能力袋）、`EffectReceipt/WorkspaceMode` 类型。
- Core：`ToolCatalog` + `PageStore` 拆分；`ContextManager` 保留为**弃用门面**（继承 `ToolCatalog`，换页委托 `PageStore`），新代码（调度器、Cell 通道、CLI runtime）用新类。
- 行为零变化：拆分前后全量测试通过。

### R3 效果收据与 Workspace

- `packages/host/src/workspace.ts`：`create` 用 `open(path,"wx")`；`overwrite` 显式；`path.resolve` + 父目录 `realpath` 双重 allow 校验；拒绝相对路径、`..` 逃逸、符号链接、非常规文件；Windows 大小写归一；identity = `dev/ino/size/mtimeMs/sha256`。
- 新通道 op `workspace.write`：授权先于认领；声明目标与实际目标比对；写入成功由宿主追加 `EFFECT_SETTLED.receipt`；收据落账失败尽力回滚新建文件。
- `fs.remove` 只对 `receipt.created === true` 且 identity 复核通过的候选执行；无收据/覆盖写/身份不符一律不删（身份不符升级）。
- 补偿候选过滤：无收据不进入内建删除，告警缝记录 `no-receipt` / `not-created`，不制造升级噪声。
- Cell 侧：`ctx.workspace.create/overwrite`（单 effect 自动绑定，多 effect 必须显式 `effectId`）；fixture 迁移为纯 handler + `ctx.workspace`。

### R4 生命周期、事务与幂等

- `setup(ctx)` / `export function dispose` / `ctx.effect` 资源栈；`cell.dispose` 正常收尾（模块 dispose → 资源 effect LIFO，幂等）；`drainAndReap` 只对已就绪的舱做 dispose 等待。
- 调度器为每次工具动作生成 `toolCallId`；`EFFECT_DECLARED.toolCallId` + 宿主 `EffectTracker` 去重；`workspace.write` 对已结算 effect 返回既有收据（重试不重复写）。
- 多 effect：每个实际操作独立结算；未执行的效果无收据，不进入补偿。

### R5 隔离与信任

- spawn 环境白名单（排除 `NODE_OPTIONS`、`*_TOKEN/KEY/SECRET`）；唯一 `fs.write` 根 = 工作区 cwd；`nodePermissionArgs` 可选透传（默认关闭，文档明确不是沙箱）。
- manifest `trust.rawIo` 申请 + 宿主 `allowRawIo` 授予；授予写入 `ASSEMBLY_RECORDED.trust`；raw 不享受内置补偿。

### 证据与门禁

- 新增/更新测试：`runtime-context/effect-scope`、`core/tool-catalog`、`host/workspace`、`host/isolation`、`host/assembler`（trust）、`host/compensator`（收据）、`tests/native-file-write-aop`（预存在/覆盖/逃逸/身份/重试/多 effect/env-cwd）、`tests/native-lifecycle`（setup/dispose）。
- 全量：**51 文件 401 测试**全绿；format / lint / typecheck / build / check-size 随收口复核。

### 与计划的偏差（如实登记）

- 收据落在 `EFFECT_SETTLED.receipt`，不新增事件类型（符合 D2 建议）。
- `RunContext` 作为冻结原语落地；Cell 进程内不存在服务替换路径（bootstrap 一次性），Host 热替换仍在既有装配器/run 边界，不新建一套 Host 容器。
- `workspaceRoot` 仅在 `fs.write.allow` 唯一可推导时用于 cwd；多根/无根不猜。
- Node 权限模型默认不启用，只提供参数透传；未做 audit 差异收集（需真实插件样本后再定）。
- 仍未做：`fs.restore`、递归删除、网络通用撤销、二进制/流式写入、跨设备原子性、符号链接 TOCTOU 的彻底消除（Node 无 `openat`）。
