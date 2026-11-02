# 文档地图

本目录是项目的**唯一事实来源**。任何会话、任何人都应能只靠这些文档理解项目并继续工作。

每份文档头部有状态标记：**草稿 → 评审中 → 定稿**。阶段开工的前提是相关设计文档已达「定稿」（流程见 [standards/03](standards/03-documentation.md)）。

## 阅读顺序建议

| 你是谁 | 读什么 |
|---|---|
| 项目所有者（不读代码） | [README.zh-CN.md](../README.zh-CN.md) → [roadmap/00-roadmap.md](roadmap/00-roadmap.md)（看板）→ CHANGELOG → `adr/`（感兴趣时） |
| 新加入的 AI 会话 | `.agents/CONTEXT.md` → [AGENTS.md](../AGENTS.md) → 本页 → 当前 phase 文档 → `standards/` 全部 → 相关架构文档 |
| 未来的人类协作者 | 同 AI 会话路径 |

## 目录结构

```
.agents/                AI 知识库与交接中枢（仓库根；规范见其 README 与 standards/08）
docs/
├── README.md            本页：文档地图
├── glossary.md          术语表（面向非技术读者）
├── research/            调研沉淀（事实与数据，决策的依据）
├── adr/                 决策记录（为什么这么做，编号递增，只增不改）
├── architecture/        架构设计（系统是什么样、关键约束）
├── roadmap/             路线图（什么时候做什么、怎么验收）
├── standards/           仓库规范（怎么做事的规则，9 篇）
├── design/              各阶段详细设计稿与阶段进度报告（design/phase-N/）
└── 仓库根另有：briefs/（所有者本地输入区，不入库）、scripts/ 脚本；
    fixtures/、examples/ 按需重建（standards/05 §2、01 §4）
```

代码目录布局（仓库根）见 [standards/01](standards/01-repo-structure.md) §2（预设 B monorepo，目录随 Phase 1 首批代码建立）。

## 文档清单与状态

> 规则：新增文档必须同步登记本表；改状态必须同步本表与 CHANGELOG；`_TEMPLATE.md` 为模板文件，不入本表。

| 文档 | 状态 | 一句话说明 |
|---|---|---|
| roadmap/00-roadmap.md | 定稿 | 总路线图、唯一进度看板、backlog 与风险登记簿 |
| roadmap/phase-0-design-baseline.md | 定稿 | Phase 0 范围合同：设计基线（架构沉淀 + A/B/D/C 四份设计）——已收官（report 见 design/phase-0/） |
| roadmap/phase-1-mvp.md | 定稿 | Phase 1 范围合同：MVP 最小闭环（做/不做清单 + 验收场景 A1~A8） |
| standards/01 ~ 09 | 定稿 | 仓库结构 / git 工作流 / 文档 / 代码 / 测试 / 安全 / AI 协作 / 体量 / 规范复查 |
| glossary.md | 草稿 | 术语表（首批 19 条） |
| adr/ADR-0001-implementation-stack | 定稿 | 实现技术栈：TypeScript / Node.js（MVP） |
| adr/ADR-0002-single-host-mvp | 定稿 | MVP 单机部署形态（接口按可远程化设计） |
| adr/ADR-0003-model-gateway | 定稿 | 模型调用统一经 Core 模型网关（预算权威记账） |
| adr/ADR-0004-ledger-consistency-point | 定稿 | 执行账本按轮边界落盘（一致点 + 恢复语义） |
| architecture/01-keel-overview | 定稿 | 架构总览：不变量、三层架构、插件模型、关键机制、验收用例 |
| design/phase-1/01-core-api-contract | 定稿 | Core API 契约：可见面矩阵、接口/事件表、错误码、超时重试、授权×预算时序、hook 白名单 |
| design/phase-1/02-compensation-state-machine | 定稿 | 补偿事务状态机：效果生命周期、触发与编排、幂等契约、三级分级、升级与豁免 |
| design/phase-1/03-plugin-manifest | 定稿 | 插件 manifest 设计：四要素、能力词表、补偿模板制、版本迁移、装配五步校验（附 schema/ 下 JSON Schema 与两示例） |
| adr/ADR-0005-cell-isolation | 定稿 | Cell 隔离选型：MVP 进程级，演进期 IsolationProvider 抽象 + 容器后端 |
| adr/ADR-0006-mit-license | 定稿 | 许可证选用 MIT（版权主体占位可改） |
| design/phase-0/report | 定稿 | Phase 0 阶段进度报告：验收 A1~A7 通过、体量与规范复查 |

> research/ 暂无文档；design/phase-1/ 另两份（补偿状态机、插件 manifest）为 Phase 0 后续交付物（见 phase-0 §4），产出即登记本表。
