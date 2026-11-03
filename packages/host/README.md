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

✅ **切片④已落地**（补偿执行器 / 恢复管理器 / 快照链路；验收 A3/A4 实现主体）：

- `CompensationExecutor`：补偿状态机 T01~T14 全路径——账本重放投影（唯一事实源，执行器崩溃不丢状态）、dependsOn 逆拓扑 + 有界并行编排、≤3 次/≤30s 退避重派、escalated 阻断 + waive/repair 所有者通道、record-only 直闭（审计留痕 + 告警缝）
- `RecoveryManager`：`recover.plan`（最近一致点 + 未决清单 + 快照引用）/ `recover.execute`（先补偿后延续，ADR-0004 顺序硬约束；快照缺失 = `RECOVER/SNAPSHOT-MISSING`，升级未豁免 = `RECOVER/COMPENSATION-FAILED`）
- `EffectTracker`：EFFECT_SETTLED 宿主结算（工具结果映射 ok→done、error/timeout→unknown 保守）+ dependsOn 声明期成环校验
- `SnapshotStore`：D3 快照宿主内存持有（账本仅 `STATE_SNAPSHOT_REF` 元数据）；快照挂载复用 `cell.migrate` 通道
- 切片③主体保留：`ProcessIsolationProvider` / `CellSupervisor`（退出三分类 + 失控强杀 + `pullSnapshot` 轮边界索取）/ `Assembler` 五步校验 / `AssemblyManager` 热装配 / `serveCellChannel`（C-M1 焊点）
- **R3（ADR-0018）**：`Workspace`——`create`(`wx`) / `overwrite`、resolve + realpath 双重路径校验、identity 收据；`workspace.write` 服务端；`fs.remove` 只认收据
- **R4**：`cell.dispose` 正常收尾（模块 dispose → 资源 effect LIFO）；`EffectTracker` 按 `toolCallId` 去重与单 effect 结算
- **R5（ADR-0019）**：spawn 环境白名单、唯一写根 cwd、manifest `trust` 申请/宿主授予（`ASSEMBLY_RECORDED.trust`）

验收 A2/A3/A4 的真实进程集成测试见 [tests/](../../tests/)（崩溃隔离 / kill 恢复延续 / 工具失败回滚补偿三路径）。施工顺序见 [docs/roadmap/phase-1-mvp.md](../../docs/roadmap/phase-1-mvp.md)。

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
