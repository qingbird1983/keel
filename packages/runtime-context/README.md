# @keel/runtime-context

Host 与 Cell 共用的运行上下文原语（[ADR-0017](../../docs/adr/ADR-0017-runtime-context-layering.md)）。**零运行时依赖**：只放类型与纯内存原语，不做 IO、授权或账本裁决。

## 导出

- `Scope` / `RunRef` / `scopeKey`：作用域形状（Core re-export，外部 API 不变）
- `RunContext`：每 Run 一份，构造后冻结身份与能力袋
- `EffectScope`：资源清理的 LIFO disposer 栈（同步/异步、幂等、错误聚合）——**不是业务补偿**
- `EffectReceipt` / `EffectIdentity` / `WorkspaceMode`：受治理写入的收据形状（[ADR-0018](../../docs/adr/ADR-0018-effect-receipts-and-workspace.md)）
- `RunNodeState`：插件节点状态（pending/loading/active/failed/unloading/disposed）

## 边界

- 业务副作用（写文件、外发请求）走效果收据与补偿，不走 `EffectScope`。
- 本包不持服务定位器、不做热替换；Host 的装配与热替换在 `@keel/host`，Run 内无服务替换路径。

```bash
pnpm --filter @keel/runtime-context typecheck
pnpm --filter @keel/runtime-context build
```
