# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 1 阶段验收收官——A1~A8 逐条实测通过、A1/A6 规模级补执行、Adapter 原型补齐交付物、报告收口 + 提交 + `phase-1.end`）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成（tag `phase-1.end`）**——切片①~⑤ + 阶段验收全部落地；八条验收场景逐条通过（一票否决五项：A1/A2/A3/A4/A6），225 测试 / 29 文件全绿，六道门禁绿，零运行时依赖
- **Phase 2 未开工**：开工前两道硬前置——① **显式迁移边界文档**（roadmap §4 风险簿要求，Cordis 全量语义承接的前提）；② 回填清单清点（见下"下一步"）
- 验收结果与证据唯一来源：`docs/design/phase-1/report.md`（含 A1/A6 口径定义、A8 复采数据、五条发现/限制）

## 上一轮完成了什么（3~5 条）

- A1 规模级实测：`tests/concurrent-scope-isolation.test.ts`——20 舱并发 ×5 轮，动态增删经 Cordis 适配器施加；可见表逐轮等于自身剧本、静止域指纹恒定、污染 0 例、3 次复跑一致
- A6 规模级实测：`tests/audit-attribution-replay.test.ts`——真实 run 51 事件 seq 连续、8 对 hook 留痕、Core 拒绝字段齐备、`basedOn` 因果不倒序，并经 `keel replay` 子进程复演输出 52 行
- A7 实测补强：`tests/gateway-fail-closed.test.ts` + `fail-closed-plugin.mjs`——越权模型零预扣零上游、预扣 100/实结 60/退 40、同 id 重放不打上游
- 交付物补齐：`packages/cordis-adapter` 接口级原型（142 行 + 9 单测）+ 新设计稿 `docs/design/phase-1/05-cordis-adapter-prototype.md`
- 验收拦缺陷修复：`keel replay` 的 BUDGET_SETTLED 取错字段 + TOOL_SCHEMA_CHANGED 截断丢 scope（复现测试先行，永久保留）

## 下一步（按优先级，注明阻塞项）

1. **等所有者定夺**：是否开工 Phase 2（开工 = 先写迁移边界文档，再定 Phase 2 范围合同；阻塞：所有者决策）
2. Phase 2 开工前的回填项（建议随 Phase 2 首个切片一并评估，逐项确认归属）：策略插件→HookBus 装配链、`model.stream` 流式通道（契约 §4.7）、旧 Cell drain 完整语义、快照物理持久化、`DECISION.basedOn` 依据集扩全（**属契约语义变更，须先开 ADR**）
3. 规范修订两处（standards/09 触发）：验收节补"交付物表逐条核对"强制项；`tests/` 纳入类型检查（根级 tsc 项目或 type-aware lint）
4. ~~远端仓库配置~~ **已启用**：`origin = github.com:qingbird1983/keel`（私有，SSH，`gh` 已登录 qingbird1983）；日常推送 = `git push origin main --follow-tags`。余下待决：版权署名占位（LICENSE + 两 README + ADR-0006）

> backlog（条件未触发，勿顺手做）：probe 通道、builtin 补偿动作、快照物理持久化、退避参数可配置面、migration 多步链、未决污染清单 CLI、Cell 池化。

## 未决问题

- 版权署名（所有者决定；仓库远端已于 2026-11-02 启用为私有 GitHub 仓库）
- `basedOn` 是否扩为"决策前全部事件"（含授权器/网关/追踪器直写事件）——影响契约 §4.1/§5 语义，Phase 2 前评估（现记录为报告 §3 限制 2）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **跨包 import 走 dist**：改 `packages/*/src` 后不重新 build 就跑 `tests/` 会得到 `x is not a function`（`exports` 指向 dist 是发布面设计，不是坑位）→ [P-002 规则 4](pitfalls/P-002-集成测试装配接线四类错.md)
- **类型检查曾依赖构建产物**：干净检出时 `pnpm typecheck` 必炸（本机因 dist 残留永远绿）；现由 `tsconfig.json` 的 `paths` 直接读兄弟包 src 解决——**新包 import workspace 兄弟包就要加 paths**，且每轮收尾应有一次"`pnpm clean` 后跑全链"→ [P-004](pitfalls/P-004-类型检查依赖构建产物.md)
- 门禁链取真实退出码：`... | tail` 会把失败吞成 exit 0（用 `... > log 2>&1; echo EXIT=$?`）；本地绿灯不等于 CI 绿灯
- **集成测试装配接线四类错**（deps/opts 参数位、模块顶层捕获未初始化、依赖材料先于组件构造、dist 解析）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **CLI 资源收束覆盖所有 spawn 源** + **冷 Ledger 实例按 runId 拒接笔**（多实例 runId 集合必须不相交；bench 各段独立 runId 即此因）→ [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- **Windows 子进程 exit 事件滞后 stdout 关闭**——死亡第一信号 = 通道关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **阶段验收执行法**（抽象主张 → 可断言口径：指纹恒定 / seq 连续 / 成对留痕；交付物表横向核对；证据行入报告）→ [S-001](skills/S-001-阶段验收执行法.md)
- 调度器是轮内事件唯一编排者但**非唯一写入者**（授权器/网关/追踪器/CLI 快照缝直写账本）：seq 仍连续、`basedOn` 不含直写事件——写归因类断言时按此事实设计，别假设依据集 = 全部前序事件
- 门禁链 `a && b && c | tail` 会把失败吞成 exit 0：取真实状态用 `... ; echo EXIT=$?` 或 pipefail
- 报告/handoff 不写本机绝对路径（standards/06）：CLI 证据行含盘符的须改写后再抄进 docs/
- cell 侧不持有 scope/runId（宿主盖章）；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022（无 Promise.withResolvers）
- 踩坑索引：[pitfalls/](pitfalls/)（P-001、P-002、P-003、P-004）；方法索引：[skills/](skills/README.md)（S-001）
