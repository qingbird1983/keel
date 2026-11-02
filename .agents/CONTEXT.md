# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 0 收官——report 通过、MIT、git 启用、tag phase-0.end）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 0 ✅ 完成（2026-11-02，验收 A1~A7 通过，tag `phase-0.end`）**
- **Phase 1 未开始**——范围合同已定稿，开工首事 = 工具链脚手架
- 看板：`docs/roadmap/00-roadmap.md` §1
- 版本控制：git 已启用（main，本地无远端；standards/02 全文生效）

## 上一轮完成了什么（3~5 条）

- design/phase-0/report.md：验收全过 + 体量/规范复查；看板翻牌 ✅
- MIT 落盘（ADR-0006 留痕，署名占位可改）；双 README 待决策表清空
- git init -b main + 首提交 + annotated tag `phase-0.end`；briefs/ 确认未入库
- 提交前清理 H-001 本机绝对路径一处（standards/01 §4 拦截实例）

## 下一步（按优先级，注明阻塞项）

1. **Phase 1 开工**：pnpm workspace 脚手架 + 门禁四连实体化（standards/04 §1 选型转实体；standards/05 §1 测试栈落地）（阻塞：无）
2. 纵向切片 A1~A6（core 四件套 + cell + 装配 + 补偿最小可用），每验收场景即测试（阻塞：脚手架）
3. 远端仓库配置（阻塞：所有者提供地址；不阻塞本地开发）

> 施工顺序唯一来源：phase-1-mvp.md（已定稿）；发现设计缺陷先改文档再改码。

## 未决问题

- git 远端（所有者）；N1~N5 结构遗留与契约/状态机待决项（随 Phase 1）
- phase-0.start tag 未打（git 启用晚于开工，已在 CHANGELOG 说明）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **路径扫描用宽关键词**（如"Warehouse"）而非转义模式——bash 双引号下 `E:\\` 模式漏检过一次（H-009）
- 版权署名"Keel Project Contributors"是占位——所有者若要具名，改 LICENSE + 两 README + ADR-0006 四处
- Phase 1 文档先行：设计稿已定稿，但实现中发现契约缺陷 → 先改文档（带注记）再改码
- 踩坑索引：暂无独立 pitfalls（险情已记 H-009）
