# Keel（龙骨）

[English](README.md) · **简体中文**

**专为 Agent Harness 设计的治理型运行时内核：把控制、隔离、账本、补偿、上下文治理做成内核原语，让 Agent 长程运行"控制不可旁路、故障不可级联、副作用不可无痕"。**

更新日志：[CHANGELOG.md](CHANGELOG.md) · 许可证：[LICENSE](LICENSE)

## 亮点

- **五大不变量作为内核原语**：控制不可旁路 / 故障不可级联 / 状态不可丢失 / 副作用不可无痕 / 上下文不可全局污染
- **水密隔舱式执行单元（Cell）**：一次 Agent 运行独占私有工具表、记忆与上下文，一个舱进水不沉整船
- **只追加的执行账本**：每轮决策可重放、可审计，长程任务可从"一致点"恢复
- **插件装配的是能力，不是控制权**：能力 / 策略 / 观测三类插件各居其位，热装配走新 Cell 切换而非全局注册表突变
- 文档先行的工程方式 —— 设计文档、ADR、规范与阶段路线图先于实现代码落盘（见 [`docs/`](docs/README.md)）。

## 当前状态

Phase 0（设计基线）已完成——四份关键设计定稿、六篇决策留痕、MIT 许可证落盘；Phase 1（MVP 实现）范围合同已定稿，即将开工。

- **路线图与进度看板**：[docs/roadmap/00-roadmap.md](docs/roadmap/00-roadmap.md)

## 文档

项目文档以**中文**维护于 [`docs/`](docs/README.md)（本 README 双语入口之一）：

| 目录 | 内容 |
|---|---|
| [`docs/research/`](docs/research/) | 调研沉淀：事实与数据，决策的依据 |
| [`docs/adr/`](docs/adr/) | 决策记录（为什么这么做，编号递增，只增不改） |
| [`docs/architecture/`](docs/architecture/) | 架构设计：系统是什么样、关键约束 |
| [`docs/roadmap/`](docs/roadmap/) | 路线图：阶段范围、交付物、验收场景 |
| [`docs/standards/`](docs/standards/) | 仓库规范 9 篇：怎么做事的规则 |
| [`docs/design/`](docs/design/) | 各阶段详细设计稿与进度报告 |
| [`docs/glossary.md`](docs/glossary.md) | 术语表（面向非技术读者） |

## 待决策（需要项目所有者拍板的事项）

> 需要所有者决策的事项集中列在此表（两份 README 同步维护），并在 CHANGELOG 条目中提醒；决策后写 ADR 并从本表移除。

| 事项 | 提出日期 | 状态 |
|---|---|---|
| （暂无——事项出现时登记于此） | — | — |

## 许可证

[MIT](LICENSE) © 2026 Keel Project Contributors（署名可随时更改，见 ADR-0006）
