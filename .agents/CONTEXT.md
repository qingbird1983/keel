# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 1 开工——工具链脚手架落地，门禁六连全绿）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 🔄 进行中（2026-11-02 开工，tag `phase-1.start`）**——已完成：pnpm workspace 脚手架 + 门禁实体化 + 五包骨架占位
- 施工顺序唯一来源：`docs/roadmap/phase-1-mvp.md`（已定稿）；当前步骤 = 纵向切片 A1~A6
- 版本控制：git main（本地无远端；feature 分支开发，standards/02 全文生效）

## 上一轮完成了什么（3~5 条）

- workspace 脚手架：root scripts（format/lint/typecheck/build/test/check-size/clean）+ `tsconfig.base.json`（strict/NodeNext ESM）+ 五包骨架（`packages/{core,host,cell-runtime,cordis-adapter}`、`apps/keel`，占位导出 + 冒烟测试）
- 门禁实体化：prettier 3 / eslint 10 + typescript-eslint 8（`--max-warnings 0`）/ vitest 5 / tsc 5.9 strict；六道门禁全绿；CI workflow 对齐
- 依赖 7 件登记 standards/04 附录 A（运行时零依赖基线）；TS 锁 5.9 线——TS7 与 typescript-eslint 8 peer 不兼容，否决理由在表
- check-size：SRC_DIRS 回填 monorepo + 新增构建产物容量哨兵（软 500MiB / 硬 2GiB）；standards/08 §6 回填；`pnpm clean` 落地
- handoff 归档 H-010；按滚动 5 份规则删除 H-001~H-005（git 历史留存）

## 下一步（按优先级，注明阻塞项）

1. **纵向切片 A1~A6**：core 四件套（调度/授权/预算/账本）+ cell-runtime + host 装配 + 补偿最小可用；每个验收场景的实现即其测试（阻塞：无）
2. 切片动工时切换 eslint 类型感知规则（eslint.config.js 内 TODO 已标）（阻塞：首批异步/IO 代码）
3. 远端仓库配置（阻塞：所有者提供地址；不阻塞本地开发；CI workflow 已就位待触发）

> 实现中发现契约缺陷 → 先改设计文档（带注记）再改码（phase-1-mvp.md §1 约束）。

## 未决问题

- git 远端（所有者）；N1~N5 结构遗留与契约/状态机待决项（随切片推进解决）
- 版权署名"Keel Project Contributors"占位——所有者若要具名：LICENSE + 两 README + ADR-0006 四处
- phase-0.start tag 未打（git 启用晚于开工，CHANGELOG 已说明）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **typescript 版本锁 ^5.9**：升级 TS7 前先查 typescript-eslint peer 范围（standards/04 附录 A 有否决理由）
- 构建会把 `*.test.ts` 编进 dist（单 tsconfig 的取舍）；发布/打包时再排除
- 路径扫描用宽关键词（如"Warehouse"）而非转义模式——bash 双引号下 `E:\\` 模式漏检过一次（H-009）
- 踩坑索引：暂无独立 pitfalls 文件（险情记录见 H-009/H-010）
