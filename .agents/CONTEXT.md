# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 1 收官与远端启用 → 署名落实 → Phase 2 开工前置两份文档起草）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end`，指向验收状态 a8b8444）；A1~A8 逐条实测通过，一票否决五项全过；结果与证据在 `docs/design/phase-1/report.md`
- **Phase 2 🟡 开工准备中**：两份前置文档已起草为**草稿**——`docs/design/phase-2/01-cordis-migration-boundary.md`（14 条旧写法 A/B/C/D 四档边界表）+ `docs/roadmap/phase-2-cordis-compat.md`（范围合同 + 验收场景 B1~B8）
- **铁律 1 生效中**：合同未定稿前**禁止写 Phase 2 实现代码**；定稿即打 `phase-2.start`
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH，`gh` 已登录）；流水线两次运行均 success；日常推送 `git push origin main --follow-tags`
- 门禁现状：六道全绿，225 测试 / 29 文件，零运行时三方依赖，单文件最大 569 行

## 上一轮完成了什么（3~5 条）

- 版权署名落实为 `qingbird1983`：新 ADR-0007（MIT 未动，ADR 只增不改）+ LICENSE + 中英 README + 文档地图 + Phase 1 报告未决项关闭
- 迁移边界文档起草：A 一行不改 / B 补报关单 / C 改一小段 / D 永远拒绝，每条带迁移改法；核心判据"禁止静默降级"
- Phase 2 范围合同起草：做与不做、三项开工前置、B1~B8 验收（B1/B4/B5 一票否决）、四条风险
- 远端启用与 CI 首跑拦缺（typecheck 依赖 dist 的固有缺陷）已修并回归——见 P-004 与 CHANGELOG 0.1.020~0.1.023

## 下一步（按优先级，注明阻塞项）

1. **等所有者三项确认**（阻塞 Phase 2 开工，全部是决策而非技术问题）：
   - ① 边界表档位归类是否认可，尤其 D 档两条（#7 自建预算/控制流、#14 策略插件绕控制面）**是否坚持零例外**
   - ② 验收材料来源：真实存量插件样本（需所有者提供或指路）vs 合成样例插件组（代价见合同风险 1）
   - ③ 回填项归属：策略插件→HookBus 装配链（默认进 Phase 2，因 #14 承接以它为前提）、`model.stream` 流式通道、快照物理持久化、旧 Cell drain 完整语义、`basedOn` 依据集扩展（此项须先 ADR）
2. 确认后：合同转定稿 → `phase-2.start` → 首切片建议 = 承接层 A/B 档 + 一个 D 档拒绝样例（文档先行：切片设计稿落 `docs/design/phase-2/02-*.md`）
3. 规范修订两处（Phase 1 报告 §8 登记，可在 Phase 2 首个文档轮一并处理）：standards/07 验收节补"交付物表逐条核对"强制项；`tests/` 根级类型检查

> backlog（条件未触发，勿顺手做）：probe 通道、builtin 补偿动作、退避参数可配置面、migration 多步链、未决污染清单 CLI、Cell 池化、容器后端、分布式。

## 未决问题

- Phase 2 三项前置确认（所有者，见"下一步"1）
- `basedOn` 是否扩为"决策前全部事件"（含授权器/网关/追踪器直写事件）——属契约 §4.1/§5 语义变更，须先开 ADR；Phase 2 若承接策略插件会再碰到它

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **类型检查不得依赖构建产物**：干净检出 `pnpm typecheck` 曾必炸（本机因 dist 残留永远绿）；新包 import workspace 兄弟包就要在它的 `tsconfig.json`（noEmit 那份）加 `paths` → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)。**每轮收尾至少一次"`pnpm clean` 后跑全链"**
- **跨包 import 走 dist（运行期）**：改 `packages/*/src` 后不 rebuild 就跑 `tests/` → `x is not a function` → [P-002 规则 4](pitfalls/P-002-集成测试装配接线四类错.md)
- **集成测试装配接线四类错**（deps/opts 参数位、模块顶层捕获未初始化、依赖材料先于组件构造、dist 解析）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **CLI 资源收束覆盖所有 spawn 源** + **冷 Ledger 实例按 runId 拒接笔** → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- **Windows 子进程 exit 滞后 stdout 关闭**——死亡第一信号 = 通道关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **阶段验收执行法**（抽象主张 → 可断言口径；交付物表横向核对；证据行入报告）→ [S-001](skills/S-001-阶段验收执行法.md)
- 调度器是轮内事件唯一编排者但**非唯一写入者**：`AUTH_DENIED`/`EFFECT_*`/`STATE_SNAPSHOT_REF` 等由组件直写，seq 仍连续但不入 `basedOn`——写归因断言按此事实设计
- 门禁链取真实退出码：`... | tail` 会把失败吞成 exit 0（用 `> log 2>&1; echo EXIT=$?`）；本地绿灯 ≠ CI 绿灯
- 文档红线：ADR 只增不改（变更写新 ADR）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径（standards/06）；CHANGELOG 面向非技术读者
- cell 侧不持有 scope/runId（宿主盖章）；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022（无 Promise.withResolvers）
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-004）；方法索引：[skills/](skills/README.md)（S-001）
