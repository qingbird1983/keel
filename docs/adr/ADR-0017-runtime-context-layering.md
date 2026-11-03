# ADR-0017：运行上下文分层与 `@keel/runtime-context`

- 状态：接受
- 日期：2026-11-03
- 关联：[07 重构计划](../design/phase-3/07-runtime-context-refactor.md)；[ADR-0015](ADR-0015-manifest-governance-and-cell-aop.md)；[ADR-0018](ADR-0018-effect-receipts-and-workspace.md)；Cordis `Context`/`Fiber` 源码（见 07 稿 §12）

## 背景

Cordis 的 `Context` 是一棵可热替换的服务树：插件通过 `ctx.foo` 取服务，Fiber 负责装载/卸载与 effect 逆序清理。它适合“能力组合”，但不适合 Agent Run：

- 服务可以在 Run 中途被替换，破坏可重放与补偿的确定性；
- 环境式定位器让插件能摸到任意服务，违反最小能力（I1/I5）；
- `ctx.effect` 是进程内资源清理，不能代替外部业务补偿。

切片③把治理计划送进了 Cell，但插件仍持有完整 `CellClient`，且没有“Run 级能力快照”。07 稿要求把 Host 的“可组合”与 Run 的“可确定”分开。

## 决策

1. **新增零依赖包 `@keel/runtime-context`**，只放共享类型与纯原语，不做 IO、授权或账本裁决：
   - `Scope` / `RunRef` / `scopeKey`（Core 改为从这里导入并继续 re-export，外部 API 不变）；
   - `RunNodeState`（`pending/loading/active/failed/unloading/disposed`）；
   - `EffectScope`：资源清理的 LIFO disposer 栈（同步/异步、幂等 dispose、错误聚合）；
   - `EffectReceipt` / `WorkspaceMode` / `RunCapabilities` 类型（与 Host/Cell 共用）。
2. **两层 Context**：
   - Host Context：长生命周期、负责装配与热替换；替换只在新 Run 或轮边界生效。
   - Run Context：每 Run 一份，创建后冻结能力句柄；Run 内不换服务、不热重载。
3. **能力句柄取代环境式定位器**：Run 侧只拿到显式授予的 `workspace/model/ledger/effects/logger`；未授予的能力在构造期缺失，访问即错（fail-closed）。本阶段不引入字符串服务注册表。
4. **拆分 Core 的 `ContextManager`**：工具目录 = `ToolCatalog`；换页 = `PageStore`。旧的 `ContextManager` 名称不再承载新代码；迁移期如保留兼容别名，必须标注弃用且只做转发。
5. `@keel/cell-runtime` 与 `@keel/host` 依赖 `@keel/runtime-context`；`@keel/core` 也依赖它（只为共享作用域/收据类型），依赖方向保持无环。

## 备选与否决

- **直接复用 Cordis Context**：带来自动重载与全局服务定位，重放会重放副作用；否决。
- **把新原语塞进 `cell-runtime`**：执行单元已接近单文件上限，且 Host 也需要收据类型；否决。
- **把 `ContextManager` 原地改名**：会把工具目录与换页继续绑在一起，且命名继续误导；否决，改为拆分。
- **通用 DI 容器**：超出需求，且给插件开放任意服务查找；否决。

## 后果

- 正面：Run 的确定性有结构载体；资源清理与业务补偿不再混用；命名回到真实职责。
- 负面：新增一个 workspace 包与依赖边；R2 必须保持行为零变化，现有 376 测试是回归基线。
- 边界：本 ADR 不实现容器隔离、不实现通用插件市场、不改变 `tool.exec` 的可见面。
- 契约影响：Core 导出名 `ContextManager` → `ToolCatalog`/`PageStore`（内部 API 变更，经 CHANGELOG 与设计稿注明）；`Scope`/`RunRef` 改为 re-export，结构不变。
