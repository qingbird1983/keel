# Phase 0：设计基线

- 状态：定稿（2026-11-02 所有者确认）
- 日期：2026-11-02
- 关联：[00-roadmap.md](00-roadmap.md) §1；ADR-0001 ~ 0004；briefs/AGENTS.md（所有者的设计协作协议，本地）

## 1. 目标

把设计简报（briefs/Keel-Design-V0.1.md，本地）沉淀为正式文档，并完成四份关键设计（Core API 契约、Cell 隔离选型、补偿状态机、插件 manifest），使 Phase 1（MVP 实现）满足"文档先行"的开工条件（standards/03）。

## 2. 范围

### 做

- ✅ 治理底座落盘（模板初始化、规范回填、看板 / CHANGELOG / 术语表 / 交接卡，2026-11-02 完成）
- ✅ 四项基础决策留痕（ADR-0001 技术栈 / 0002 单机 / 0003 模型网关 / 0004 账本一致点，2026-11-02 完成）
- 架构总览沉淀：briefs/Keel-Design-V0.1.md → `docs/architecture/01-keel-overview.md`（五大不变量、三层架构、插件模型、验收用例表）
- **A**：Keel Core API 契约 → `docs/design/phase-1/01-core-api-contract.md`（接口表、事件表、错误码、超时与重试语义、授权与预算交互、策略 hook 白名单）
- **B**：Cell 隔离级别选型 → `docs/adr/ADR-0005-cell-isolation.md`（进程 / 容器 / microVM 权衡；对 API 超时、故障语义、Cell 生命周期的影响）
- **D**：补偿事务状态机 → `docs/design/phase-1/02-compensation-state-machine.md`（状态转移表 / 状态图，覆盖失败路径与幂等性）
- **C**：插件 manifest schema → `docs/design/phase-1/03-plugin-manifest.md` + 独立 JSON Schema 文件（权限声明、资源需求、补偿语义、版本约束四要素）
- Phase 1 范围合同草案 → `docs/roadmap/phase-1-mvp.md`（Phase 0 收尾时转定稿）

### 不做（明确排除）

- 任何实现代码与工具链脚手架（pnpm workspace / CI 实装属 Phase 1）
- Cordis Adapter 详细设计（Phase 2 前置；Phase 1 仅做原型级接口预留）
- 分布式 / 多机设计（ADR-0002 已排除）
- 性能基准（Phase 1 验收内容，本阶段只定义基准场景）

## 3. 开工前置条件

- ✅ 治理底座落盘（2026-11-02）
- ✅ 四项基础决策 ADR-0001 ~ 0004（2026-11-02，所有者已答复）
- ✅ 设计简报在位（briefs/Keel-Design-V0.1.md）

## 4. 交付物

| 类别 | 清单                                                                                          |
| ---- | --------------------------------------------------------------------------------------------- |
| 文档 | architecture/01-keel-overview.md；ADR-0005；design/phase-1/01、02、03；roadmap/phase-1-mvp.md |
| 其他 | manifest JSON Schema 文件（随 03 附 `schema/` 目录）+ 2 个示例 manifest                       |

## 5. 验收场景（逐条可执行；验收结果记入 report.md）

> 标注【一票否决】的场景未通过时不得打 `phase-0.end` tag。

- [ ] A1 冷启动：任一新会话不读 `briefs/`，仅凭仓库文档复述五大不变量、三层分工与当前任务
- [ ] A2【一票否决】四份设计文档（A/B/D/C）均定稿，且每份显式引用 ≥1 个 DSH 症状作为设计输入或验收用例（全局工具注册污染 / 插件崩溃拖垮进程 / Agent Loop 可被插件替换 / "卸载即无痕"失效 / 缺统一执行账本 / 热插拔依赖全局注册表突变）
- [ ] A3 每份设计文档附自检清单，逐条说明如何满足五大不变量
- [ ] A4【一票否决】ADR-0005 显式说明隔离决策对 API 超时、故障语义、Cell 生命周期（含补偿执行入口）的影响
- [ ] A5 manifest schema 能校验通过 2 个示例（能力插件、策略插件各一），且含权限 / 资源 / 补偿 / 版本四要素
- [ ] A6 补偿状态机覆盖三条路径：补偿自身失败、幂等重入、不可逆操作降级
- [ ] A7 工作协议遵守：每份文档先"提纲 + 决策点 + 备选权衡"经所有者确认，再成文（briefs/AGENTS.md 协议）

## 6. 依赖与风险

- 所有者逐份确认（提纲 → 全文两道闸）是节奏瓶颈 → 缓解：提纲控制在一屏内，一次只推进一份文档
- B 的结论可能反压 A 的超时表 → 顺序定为 A → B → D → C；A 中隔离敏感参数显式标注"ADR-0005 定稿后回填"
- 设计简报仍为 V0.1，若所有者后续修订 → 差异走 CHANGELOG + 必要时 ADR，架构总览同步修订（简报不是事实来源）
