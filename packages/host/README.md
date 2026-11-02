# @keel/host

Keel 宿主层（Host Layer）：跑在用户态的"船坞"——负责执行单元的创建、监控、装配与恢复，把内核 [`@keel/core`](../core/README.md) 的治理原语落到真实进程上。

## 职责（对应架构总览 §4.2）

| 组件              | 职责                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| IsolationProvider | 隔离后端抽象；MVP 为 OS 进程后端（容器化留待演进期，ADR-0005）                 |
| Cell Supervisor   | Cell 生命周期管理；轮边界索取并持有状态快照；故障检测与恢复执行                |
| 装配器            | manifest 发现、五步校验、依赖解析、作用域绑定；热装配 = 新 Cell 验证后原子切换 |
| 补偿执行器        | 补偿状态机全路径（T01~T14）、幂等重派、升级豁免                                |

## 当前状态

🚧 **Phase 1 脚手架占位**——实现随纵向切片落地：Supervisor/IsolationProvider/装配器在切片③（验收 A2/A5），补偿执行器在切片④（验收 A3/A4/A6）。施工顺序见 [docs/roadmap/phase-1-mvp.md](../../docs/roadmap/phase-1-mvp.md)。

## 目录与开发

```text
src/    实现
test/   单元测试（与 src/ 一一对应镜像）
```

```bash
pnpm --filter @keel/host typecheck
pnpm --filter @keel/host build
pnpm test   # 全仓测试（根目录执行）
```

## 关联文档

- manifest schema：[docs/design/phase-1/03-plugin-manifest.md](../../docs/design/phase-1/03-plugin-manifest.md)
- 补偿状态机：[docs/design/phase-1/02-compensation-state-machine.md](../../docs/design/phase-1/02-compensation-state-machine.md)
- 隔离选型：ADR-0005
