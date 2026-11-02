# Phase 1：MVP 最小闭环

- 状态：定稿（2026-11-02 所有者确认；一经定稿即约束实现，超范围先 ADR）

- 日期：2026-11-02

- 关联：[00-roadmap.md](00-roadmap.md) §1；[phase-0-design-baseline.md](phase-0-design-baseline.md)；[architecture/01](../architecture/01-keel-overview.md) §8；ADR-0001 \~ 0005；[design/phase-1/](../design/phase-1/) 三份设计稿

## 1. 目标

交付设计简报 §8 的最小闭环：一个可运行的 Keel——Core 四件套 + 进程级 Cell + manifest 装配 + 补偿回退 + 策略 hook + Adapter 原型——并在真实执行中逐条复验 DSH 六症状的验收用例（V1\~V6）。

## 2. 范围

### 做

- **工具链实体化**：pnpm workspace（standards/01 §2 预设 B）+ prettier / eslint / vitest 门禁四连落地（standards/04 §1 选型转实体）

- **Keel Core**（`packages/core`）：调度器（轮循环 + CHECKPOINT）、授权器（fail-closed 词表执行）、预算器（三级嵌套，实现 Run+Session）、账本（append-only 分段文件 + 一致点）、上下文管理器（scope 分区 + tool.discover）、模型网关（授权→预扣→代理→实结；上游可打桩）、策略扩展点（四 hook 白名单）

- **Cell 运行时**（`packages/cell-runtime`）：Cell 进程体、私有工具表、越界效果声明（EFFECT\_DECLARED 发起端）

- **Host Layer**（`packages/host`）：IsolationProvider（进程后端）、Cell Supervisor（生命周期 + 快照持有 + 恢复执行）、装配器（五步校验 + 热装配作用域切换）、补偿执行器（状态机全路径 + 幂等重派 + 升级豁免）

- **Adapter 原型**（`packages/cordis-adapter`）：`ctx.tools.register()` → scope 注册的最小映射（接口级，验证迁移路径可行性）

- **可执行载体**（`apps/keel`）：CLI 演示载体——装配 manifest、跑 demo Run、执行恢复演练（验收场景的执行入口）

- **fixtures**：schema 负路径组、账本回放组、补偿桩组

### 不做（明确排除）

- 容器 / microVM 隔离后端（backlog，触发条件见 ADR-0005）

- 分布式 / 多机（ADR-0002）

- 观测插件生态（仅保留只读接口与事件订阅位，无生态建设）

- Cordis 全量语义迁移（Phase 2；本阶段 Adapter 仅接口原型）

- 资源硬强制（memoryMbSoft / maxToolCallsPerRound 维持软限）

- 性能优化（只建基准测量，不调优——基准数据供 backlog 决策）

- 任何 UI

- `budget.configure` 热更新（MVP 配置文件装载，接口已预留）

## 3. 开工前置条件

- [x] 本合同 + 其引用设计稿全部定稿（standards/03：architecture/01、契约、状态机、manifest 均已定稿 ✅；本合同 2026-11-02 所有者确认定稿）

- [x] 工具链脚手架落地（pnpm workspace + 门禁四连可跑；切片①首事达成）

- [x] git 已启用、LICENSE 已定（standards/02 全文生效；Phase 0 收官轮落盘 MIT 并启用 git）

## 4. 交付物

| 类别 | 清单                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 代码 | packages/core、packages/host、packages/cell-runtime、packages/cordis-adapter（原型）、apps/keel（CLI） |
| 文档 | design/phase-1/ 三份设计稿（已定稿 ✅）；design/phase-1/report.md（阶段进度报告）                      |
| 其他 | fixtures 三组；基准测量脚本与数据（账本吞吐 / 网关延迟 / Cell 冷启动，验收 A8 附带产出）               |

## 5. 验收场景（逐条可执行；结果记入 report.md）

> 标注【一票否决】的场景未通过时不得打 `phase-1.end` tag。**执行结果与证据：[design/phase-1/report.md](../design/phase-1/report.md)（2026-11-02 阶段验收轮，八条全过）。**

- [x] A1【一票否决】（V1）20 个会话并发运行动态增删工具：各 scope 工具表互不可见，缓存命中率稳定，无跨会话污染
- [x] A2【一票否决】（V2）注入抛未捕获异常的插件：仅该 Cell 失败（RUN\_FAILED + crash 原因码），其他会话不受影响
- [x] A3【一票否决】（V3）长程任务中途 `kill -9` Cell 进程：`recover.plan` 给出最近一致点与未决补偿清单，`recover.execute` 后以新 runId 延续
- [x] A4【一票否决】（V4）工具调用失败触发回滚：全部已发生效果有对应 COMPENSATION\_EXECUTED（或有意识豁免记录），补偿三路径（自身失败升级 / 幂等重入 / record-only 降级）实测通过
- [x] A5（V5）热装配升级：manifest 新版本 → 新 Cell 验证 → 原子切换；注入迁移钩失败 → 回退旧作用域，全程无全局注册表突变痕迹
- [x] A6【一票否决】（V6）审计归因：任选一个 Run，从账本重放完整决策序列，含每次 hook 介入与 AUTH\_DENIED 留痕
- [x] A7 预算权威记账：模型调用经网关预扣/实结、同 id 重放不重复计费；Cell 内直连路径被授权器拒绝（fail-closed 实测）
- [x] A8 质量门禁：契约 §9 五个契约级测试点全绿；门禁四连（fmt/lint/test/check-size）通过；三项基准数据入 report.md

## 6. 依赖与风险

- 依赖：Phase 0 全部产出（已就绪）；Node ≥22 / pnpm ≥9 环境

- 风险（承接 roadmap 风险簿）：进程隔离内存压力（A1 并发下实测，池化预案在 backlog）；账本吞吐（fsync 频率 = 轮频率，A8 基准，重评条件 ADR-0004）；补偿编排延迟（长依赖链，A4 实测）；单人 8\~12 周估时的节奏风险（两道闸照常，超期即缩减"不做"清单外的范围须 ADR）

- 缓解原则：先打通 A1\~A6 最小纵向切片，再补 A7/A8 横向质量项；每个验收场景对应的实现即该场景的测试
