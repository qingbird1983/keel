# Cordis Adapter 原型：旧插件 API 到 scope 注册的接口级映射

- 状态：定稿（2026-11-02 所有者确认「验收轮补接口级原型」；Phase 1 交付物表列明的最后一项）
- 日期：2026-11-02
- 关联：[phase-1-mvp](../../roadmap/phase-1-mvp.md) §2「做」清单；[architecture/01](../../architecture/01-keel-overview.md) §7（兼容与迁移）；[01-core-api-contract](01-core-api-contract.md) §4.6（context 分区）；ADR-0001（TS/Node 选型动机）

## 1. 定位与边界

验证"存量 Cordis 插件不改代码迁入 Keel"这条迁移路径**是否可行**，只做接口级最小映射：把旧框架的全局注册表写法 `ctx.tools.register(name, schema, handler)` 映射为 Keel 的**按 scope 注册**，映射不到的语义**显式报错**，不静默降级。

不做（全部留 Phase 2，见 roadmap）：全量语义承接、manifest 合成、共享 Context 的只读注入通道、effect 回收 → 补偿声明的自动转换、handler 执行接管（handler 仍由插件自己持有，Core 只认工具名）。

## 2. 接口面（原型范围）

```ts
createCordisCtx({ ctx, ref }) // ctx = @keel/core ContextManager；ref = 该插件所属 Run 引用（Cell↔Run 一一对应，契约 §3.2）
  .tools.register({ name, schema?, handler? })  // → ctx.registerTool(ref, {name, schemaVersion, schema})
  .tools.remove(name)                            // → ctx.removeTool(ref, name)
  .tools.list()                                  // → ctx.discover(ref)，仅本 scope
```

三条规则：

1. **绑定时即定作用域**：ref 在 `createCordisCtx` 时绑定，注册调用本身不再接受作用域参数——旧框架"谁都能往全局表插一笔"的形状在此处消失；作用域分区未由宿主分配时，Core 直接以 `CTX/SCOPE-UNKNOWN` 拒绝（适配器不擅自 alloc）。
2. **覆盖语义映射**：同名重复注册 = 更新且 `schemaVersion` 单调 +1（对应旧框架的覆盖注册），版本号取自 Core 当前条目推导，适配器不自存状态；变更日志仍由 Core 按 scope 传播（`TOOL_SCHEMA_CHANGED` 只到受影响 scope）。
3. **handler 不进内核**：适配器不保存、不执行 handler，只登记可见性；执行仍走 Cell 私有工具表（契约 §3.3 可见面矩阵）。

## 3. 有损边界（显式报错清单）

| 旧用法                          | 原型行为                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| 无 scope 绑定即创建适配器       | 抛 `ADAPTER/SCOPE-REQUIRED`（拒绝构造"全局视图"）                        |
| `ctx.share.*`（跨插件共享状态） | 抛 `ADAPTER/UNSUPPORTED`，提示改为「只读注入 + 显式能力申请」（Phase 2） |
| `ctx.effects.reclaim()`         | 抛 `ADAPTER/UNSUPPORTED`，提示改为补偿声明（`EFFECT_DECLARED`，状态机）  |
| 经适配器读取他域工具表          | 结构上不存在此参数位（`tools.list()` 只回本 scope）                      |

错误码归属：`ADAPTER/*` 是适配器抛给存量插件的本地错误，**不入 Core 契约 §6 词表、不落账本、不过通道**（它发生在装配/注册期，不属于运行期裁决）。

## 4. 与验收场景的关系

A1（V1，一票否决）的"动态增删工具"以本原型为施加通道：20 个会话各持一份适配器实例，按旧 API 形状注册/下线工具，断言仍归 Core 账本与 scope 分区（可见表互不可见、变更事件只到受影响 scope）。因此 A1 同时回答了两个问题：**新内核不被全局注册污染**，且**旧写法迁入后仍然不被污染**。

## 5. 实现期定案（2026-11-02）

1. 原型只有一个入口函数 + 一个错误类（无状态机、无队列、无缓存），代码量控制在百行内——**接口级原型即验收标准**，不做"顺手完善"。
2. 适配器不自建工具表：任何"自己在内存里记一份全量插件表"的做法都等于把全局注册表搬进 Keel，与迁移目的相反；单一事实源是 `ContextManager` 的 scope 分区。
3. 不合成 manifest：存量插件的权限/资源/补偿声明在 Phase 2 由运行观察收敛，本阶段不猜（避免把未经校验的权限面带进装配五步）。
