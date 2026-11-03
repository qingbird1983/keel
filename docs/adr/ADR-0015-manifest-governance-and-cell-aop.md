# ADR-0015：Manifest 治理声明与 Cell-Runtime AOP 拦截器

- 状态：接受
- 日期：2026-11-03
- 关联：[04 稿](../design/phase-3/04-cell-runtime-aop.md)；[ADR-0010](ADR-0010-runtime-tool-registration-channel.md)；[ADR-0011](ADR-0011-cell-load-gate.md)；[ADR-0016](ADR-0016-builtin-compensation-registry.md)

## 背景

原生插件的工具 handler 当前必须接收 `ctx.client`，自己调用 `authCheck`、自己算摘要、自己先 `declareEffect`，然后才写业务。治理动作和业务代码混在一起，且极易漏声明。根因不是接口形状，而是 **manifest 只到宿主、不到 Cell 进程**：Cell 启动时只收到插件路径与超时，不知道自己被允许做什么、哪个工具对应哪种效果。

插件是零 import 的（B4-deps），不能用 TypeScript 装饰器/注解表达切面；切面声明只能放在 manifest 里，由运行时织入。

## 决策

1. manifest 新增顶层 `governance` 节（仅 capability）：`tools[]` 每项声明 `name`、可选 `guard`、可选 `effects[]`。
   - `guard = {cap: "fs.read"|"fs.write", from: "<param>", prefix?: string}`；守卫调用既有 `auth.check(cap, prefix + params[from])`，规则来源仍是 `manifestAuthRules`。
   - `effects[] = {kind, targetFields[], digestFields?[]}`；`kind` 必须命中 `compensation.templates[].kind`；目标/摘要只支持顶层字段名，不引入表达式语言。
2. 宿主把治理声明编译成 `CellGovernancePlan`，经既有 `spawnCell` 的 `bootstrapExtra` seam 随舱下发；**不新增通道 op、不新增事件、不新增错误码**。
3. Cell-Runtime 在 `tool.exec` 的 `hardTimeout` 内执行拦截器链：
   `guard → 逐个 effect.declare → handler(params, ctx.effects)`。
   声明失败/守卫拒绝 = handler 不执行（fail-closed，先声明后动手）；`ctx.effects` 只读地提供 `kind/effectId/seq/targetSummary/paramsDigest`。
4. `markReady()` 增加计划绑定校验：计划点名的工具必须已在本地执行表登记，否则装载即失败（可见失败优于静默不生效）。
5. 原 `compensations` / `migrate` / `snapshot` 导出面不变；Cordis 适配层不生成计划，继续手动声明；echo 与纯 `(params)` handler 零改动。

## 备选与否决

- **代码装饰器/注解**：插件零 import，无法表达；否决。
- **把整份 manifest 塞进 Cell**：扩大舱内可篡改面与耦合，Cell 只需执行映射；否决。
- **包装函数 `withEffect(handler)`**：仍是插件作者手写胶水，违背“治理下沉”；否决。
- **Cell 内本地复制授权规则**：双源漂移；守卫必须问内核授权器；否决。

## 后果

- 正面：handler 零治理调用；声明由 manifest 单一来源；effectKind/模板仍由内核 C-M1 二次校验；旧账本/旧插件兼容。
- 负面/边界：AOP 跑在插件自己的进程里，**不是沙箱**——恶意插件仍可直接 IO；真正边界仍是 Cell 隔离 + manifest 授权 + 评审。工具级 retry 会重新声明 effect（新 effectId）；跨 attempt 幂等需目标系统 natural 幂等或另案携带 toolCallId。
- 契约变更：manifest Schema 新增 `governance`（含 dated 注记）；`CellTool` 第二参数扩为 `{client, effects}`（结构超集，旧 handler 可赋值）。
