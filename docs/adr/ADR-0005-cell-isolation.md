# ADR-0005：Cell 隔离级别——MVP 采用 OS 进程级，演进期经隔离后端抽象容器化

- 状态：定稿
- 日期：2026-11-02
- 关联：[ADR-0001](ADR-0001-implementation-stack.md)、[ADR-0002](ADR-0002-single-host-mvp.md)、[architecture/01](../architecture/01-keel-overview.md) §4.3、[Core API 契约](../design/phase-1/01-core-api-contract.md) §7（超时回填）
- 取代：无

## 背景

验收用例 V2（插件崩溃拖垮进程）要求故障边界 = Cell 边界；设计简报要求"至少进程级隔离"。候选：进程内隔离（worker_threads / V8 isolate）、OS 进程、OCI 容器、microVM。约束：TS 栈（ADR-0001）、单机 MVP（ADR-0002）、开发机为 Windows（容器传统上需 WSL2；所有者确认本机已有 Windows 官方容器/WSL 可用于试验）。Phase 0 验收 A4 要求本 ADR 显式说明对 API 超时、故障语义、Cell 生命周期（含补偿执行入口）的影响。

## 决策

1. **MVP = 每 Cell 一个独立 OS 进程**（Node `child_process`，stdio JSON 行即契约 §3.1 通道）；Cell 与 Core/Host 不共享堆。
2. **S5 裁决：worker_threads / V8 isolate 不得作为 Cell 边界**——共享进程堆与原生模块地址空间，无法兑现故障边界（等于复现 V2）。Cell 内 CPU 密集任务可用 worker 线程，属 Cell 内部实现，不构成隔离声明。
3. **隔离后端抽象**：Supervisor 经 `IsolationProvider` 薄接口（`spawn / kill / alive / exitCode / onExit`）操作 Cell；MVP 后端 = 本机进程。
4. **演进期 = 容器后端**（OCI；Linux 生产，本机可用 Windows 官方容器/WSL 先行试验），按同接口接入，契约不变；microVM（Firecracker 类，仅 Linux host）为再进一步候选，启用须新 ADR。
5. **补偿执行入口 = Host 层补偿执行器**（状态机归任务 D）；不依赖故障 Cell 存活——Cell 死亡后补偿由 Supervisor 以 Host 侧上下文（或新 Cell）执行。

## 对契约与运行语义的影响（契约 §7 已回填）

- **超时**：`run.start` 维持 5s（进程 spawn ~100-300ms，余量充足；容器后端启用时重估为 ~15s 并修订契约）；`recover.execute` 维持 30s（重建 = respawn + 快照挂载）。
- **故障语义**：Cell 进程退出三分类——`clean`（exit 0）/ `crash`（非零退出或致命信号）/ `killed`（Supervisor 强杀）；三类均写 `RUN_FAILED` + 原因码入账本；`crash` 与 `killed` 必触发恢复核对路径（含未决补偿，契约 §4.5）。
- **Cell 生命周期**（Supervisor 持有）：`creating → ready → running → halting → exited（补偿核对）→ reaped`；非正常退出可从 `exited` 进入 `recovering`。

## 理由

- **OS 进程**：当前环境下唯一零外部依赖兑现"故障不可级联"的级别；spawn 成本低；stdio 与契约通道天然对齐。
- **容器级 MVP**：传统路径需 WSL2/Docker Desktop，冷启动秒级、运维前置，MVP 无验收用例回收此成本——否决（其隔离优势对当前威胁模型过剩）。
- **worker_threads**：无硬件级隔离，原生模块崩溃与内存泄漏直杀宿主进程，V2 复现——否决。

## 后果

- 积极：V2 可验收；MVP 零外部依赖；`IsolationProvider` 使容器化成为新增后端 + 配置切换，契约与账本事件不变。
- 代价/风险：进程级不防内核级逃逸与侧信道（治理场景下可接受；敌对插件场景启用容器后端评估）；每 Cell 进程 RSS 基线 ~30-50MB，20 会话并发下有内存压力 → Cell 池化已在 roadmap backlog。
- 重评条件：并发验收不达标 → 池化立项；出现敌对/不可信插件场景 → 容器后端启用评估（新 ADR）。
