# ADR-0001：实现技术栈选用 TypeScript / Node.js

- 状态：定稿
- 日期：2026-11-02
- 关联：briefs/Keel-Design-V0.1.md（本地简报，正式沉淀见 architecture/01，Phase 0 产出）；ADR-0002、ADR-0005（待写）
- 取代：无

## 背景

Keel Core、Host Layer、Cell 运行时与 Cordis Adapter 需要确定实现语言。候选：TypeScript/Node、Rust、Go。关键约束：MVP 必须交付 Cordis Adapter 承接 DSH/Cordis 存量生态（`ctx.tools.register()` 风格的 TS 插件 API）；控制面职责（调度/授权/预算/账本）是 I/O 密集而非计算密集；MVP 交付速度优先。

## 决策

1. Keel 全部组件（Core、Host Layer、Cell 运行时、Cordis Adapter）以 TypeScript（strict 模式）实现，运行时 Node.js ≥ 22 LTS，包管理 pnpm（workspace monorepo，布局见 standards/01 §2 预设 B）。
2. Core 与 Cell 之间只允许**结构化请求/事件通道**（JSON 可序列化协议）通信。这是语言绑定的唯一耦合点：未来任何组件局部重写（如账本存储引擎换 Rust）不得破坏该契约。
3. 不引入原生 addon（node-gyp 类）依赖；性能敏感路径先测量后决策，不预先优化。

## 理由

- TS/Node 与存量生态同构，Cordis Adapter 迁移成本最低；I/O 密集控制面 Node 足任。
- Rust：隔离与性能最优，但 MVP 交付慢，且与 TS 插件生态互操作需 FFI/IPC 桥接，桥接层本身成为新风险面。
- Go：进程管理成熟，但同样需要桥接层，且与插件生态语言不亲。

## 后果

- 积极：MVP 交付快；存量插件存在直接迁移路径；全链路同构调试。
- 代价/风险：进程内无强内存隔离，隔离只能依赖进程边界（Cell 隔离选型见 ADR-0005）；CPU 密集任务（如全量重放校验）需 worker 线程或未来外部化。
- 重评条件：Phase 1 性能基准中账本吞吐不达标 → 账本存储引擎可单独以其他语言实现，走新 ADR，契约不变。
