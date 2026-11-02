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

✅ **切片③已落地**（Supervisor / IsolationProvider / 装配器；验收 A2/A5 实现主体）：

- `ProcessIsolationProvider`（进程后端，ADR-0005 薄接口）+ `CellSupervisor`（生命周期 + 退出三分类 `CELL/CRASH|KILLED|CLEAN-EXIT` → 调度器 abort 缝 + 失控强杀宽限）
- `Assembler` 五步校验（Schema 子集校验器，零运行时依赖；权限交叉 / 资源上限 / 版本协商）+ `AssemblyManager` 热装配（迁移钩失败即回退旧作用域，V5）
- `serveCellChannel`：Core 侧 Cell 通道服务（契约 §3.3 可见面强制 + C-M1 焊点：未声明 effectKind 拒绝且不留副作用）

补偿执行器随切片④（验收 A3/A4/A6）接入；快照持久化与 `recover.*` 同批。施工顺序见 [docs/roadmap/phase-1-mvp.md](../../docs/roadmap/phase-1-mvp.md)。

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
