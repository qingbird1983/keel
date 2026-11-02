# H-010：工具链脚手架与 Phase 1 开工

- 日期：2026-11-02
- 分支：`chore/toolchain-scaffold`（合并 main 后打 tag `phase-1.start`）

## 本轮做了什么

- pnpm workspace 脚手架：root `package.json`（六道门禁脚本 + clean）、`pnpm-workspace.yaml`、`tsconfig.base.json`（strict + NodeNext ESM + verbatimModuleSyntax）
- 五个包骨架（仅可编译的占位导出 + 冒烟测试，无业务逻辑）：`packages/{core,host,cell-runtime,cordis-adapter}` + `apps/keel`（bin 占位）
- 门禁实体化：prettier（.prettierrc + ignore）、eslint 10 平面配置（typescript-eslint 8 recommended，`--max-warnings 0`）、vitest 5 根配置（packages/apps/tests 三处 include）、CI 对齐六道门禁
- 依赖登记 7 件进 standards/04 附录 A；TS 锁 5.9 线（TS7 原生编译器与 typescript-eslint 8 peer 不兼容，准入表有否决理由）
- check-size：SRC_DIRS 回填 monorepo 布局；新增构建产物容量哨兵（软 500MiB WARN / 硬 2GiB 阻断）；`scripts/clean.mjs` + `pnpm clean`
- standards/04 §1 注记与状态行、standards/05 状态行、standards/08 §6 上限回填；看板翻牌"进行中"；CHANGELOG 0.1.011

## 验证

- 六道门禁全绿：format:check / lint（0 warning）/ typecheck（5 包）/ build（5 包）/ test（4 冒烟通过）/ check-size
- `node apps/keel/dist/main.js` 可执行；`pnpm clean` 实测删除产物
- prettier 首跑顺带规范化了 6 份既有 docs 的空白（内容未动）

## 遗留与下一步

1. 纵向切片 A1~A6（core 四件套 + cell + 装配 + 补偿最小可用）；每验收场景即测试；发现契约缺陷先改文档再改码
2. CI 实际触发依赖远端仓库（所有者提供地址后配置；workflow 文件已就位）
3. eslint 类型感知规则（recommendedTypeChecked + projectService）留了 TODO：首批异步/IO 代码落地时切换

- 已提取沉淀：无新增 P/S（TS7 peer 约束已沉淀进 standards/04 附录 A，不另开 pitfall）

## 惯例提醒

- 构建会把 `*.test.ts` 一并编进 dist（单 tsconfig 换零配置重复；打包/发布时再处理）
- 门禁命令以 standards/04 §1 表为准，本地 = CI
