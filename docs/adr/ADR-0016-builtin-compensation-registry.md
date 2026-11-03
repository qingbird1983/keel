# ADR-0016：宿主侧内置补偿注册表与 record-only 极简声明

- 状态：接受
- 日期：2026-11-03
- 关联：[05 稿](../design/phase-3/05-builtin-compensation.md)；[补偿状态机](../design/phase-1/02-compensation-state-machine.md) §7/§9；[manifest 稿](../design/phase-1/03-plugin-manifest.md) §5.4；[ADR-0015](ADR-0015-manifest-governance-and-cell-aop.md)

## 背景

越界副作用必须先声明补偿，但“每个插件作者手写 undo 状态机”会把插件生态的开发成本推到不可接受。manifest 早已允许 `action.type: "builtin"`，然而宿主补偿执行器只认插件动作 Cell，builtin 分发从未实现；`record-only` 虽然不需要撤销代码，却仍被强制填写无意义的 `action`/`idempotency`。

## 决策

1. **宿主侧内置补偿注册表**（`packages/host/src/builtins.ts`）：闭集 `BUILTIN_REFS`，首批 `fs.remove` 与内部 `record-only`。
   - `CompensationExecutor` 新增可选 `builtins`（默认内置表）；装配期拒绝未知 builtin ref（fail-closed）。
   - 非 record-only 且 `actionType:"builtin"` 的候选**不 spawn 补偿 Cell**，直接在宿主执行；错误仍走既有重试/升级/豁免，不新增错误码。
2. **`EFFECT_DECLARED` 追加 `compensation.actionType`**（`plugin | builtin`，可选；旧账本缺失按 `plugin` 读）。`cell-server` 从 manifest 模板填充。
3. **`fs.remove` 语义**：删除本次正向操作创建的文件；`targetSummary.path` 为绝对路径；按本 run `ASSEMBLY_RECORDED.permissions` 的 `fs.write.allow` 复核 `fs:` + 归一化路径；`rm(path,{force:true})` 容忍不存在；不递归、不做覆盖恢复。
4. **record-only 极简声明**：模板只需 `{kind, class:"record-only"}`；装配器归一 `action:{type:"builtin",ref:"record-only"}`、`idempotency:"natural"`；Schema 用 `if/then` 对 reversible/mitigable 继续强制 action + idempotency。
5. **网络类不承诺通用撤销**：HTTP 无通用逆操作；用 `record-only`（审计 + 告警）或插件自定义补偿。未来若做 `net.request` 内建，必须显式声明撤销请求并另写 ADR。
6. 覆盖写走 `record-only` 或插件补偿；`fs.restore`（pre-image 备份/恢复）登记 backlog，不在本片承诺。

## 备选与否决

- **通用 undo DSL / 表达式语言**：无法覆盖网络与业务语义，且会成为新的攻击面；否决。
- **在 Cell 内执行内建**：需要为每个内建保留插件进程，违背“免写代码/免起进程”的初衷；否决。
- **代码生成撤销 handler**：仍是插件内的代码，且生成物难以审计；否决。
- **默认 record-only**：会静默放弃可撤销操作，违背 I4 的申报压力；否决。

## 后果

- 正面：`file-writer` 插件零撤销代码、零治理胶水；纯内建 run 不再 spawn 第二个补偿进程；`record-only` 的 manifest 降到一行。
- 负面/边界：`fs.remove` 只适用于“新建文件”，覆盖写会丢旧内容——必须在文档与 REVIEW 中显式说明；内建执行在宿主，必须严格按 run 权限复核路径；未知 builtin/旧账本兼容由装配期与投影默认值兜底。
- 契约变更：`EffectDeclaredPayload.compensation.actionType` 追加（旧账本可读）；manifest Schema 的模板必填条件调整（dated 注记）。
