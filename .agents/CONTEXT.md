# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 1 收官 → 远端启用与 CI 拦缺 → 署名落实 → **Phase 2 开工**）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end` = a8b8444）：A1~A8 逐条实测，一票否决五项全过；结果与证据 `docs/design/phase-1/report.md`
- **Phase 2 🔄 开工**（tag `phase-2.start`）：范围合同与迁移边界文档**均已定稿**，三项开工前置由所有者确认；估时 10~14 周量级；**尚未写任何实现代码**
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（含 §7 六片切分）；边界 `docs/design/phase-2/01-cordis-migration-boundary.md`（14 条 A/B/C/D 档 + 迁移改法）；`docs/adr/ADR-0008-*`（依据上界游标，切片⑤实现）
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；流水线 success；署名 = `qingbird1983`（ADR-0007）
- 门禁现状：六道全绿，225 测试 / 29 文件，零运行时三方依赖，单文件最大 569 行

## 上一轮完成了什么（3~5 条）

- 版权署名落实：ADR-0007 + LICENSE + 中英 README + 文档地图同步（MIT 不动，ADR 只增不改）
- 迁移边界文档起草并定稿：14 条旧写法逐档 A 直用 / B 补声明 / C 改写 / D 拒绝，判据"禁止静默降级"
- Phase 2 范围合同定稿：做/不做、B1~B8 验收（B1/B4/B5 一票否决）、五条风险、六片切分、估时回填
- 所有者三项确认落地：D 档零例外 / 合成组打底 + 真样本补跑 / Phase 1 四项回填全部进 Phase 2
- ADR-0008：决策依据改"关键引用 `basedOn` + 上界 `throughSeq`"，覆盖组件直写事件且不做全集枚举

## 下一步（按优先级，注明阻塞项）

1. **切片①设计稿**（`docs/design/phase-2/02-adapter-skeleton.md`，定稿后才写代码——铁律 1）：旧 `ctx.*` 可见面到 Keel 受控等价物的映射面 + A 档合成样本设计（**必含最坏写法探针**：动态 require、原型链补丁、进程级全局 hack、加载顺序依赖）→ 锚 B1 与 B5 部分（阻塞：无）
2. 设计稿需定的口径（写稿时逐项定案并留痕）：承接层的 seam（旧 ctx 形状在哪构造、谁绑定作用域）、合成 manifest 的最小声明面与追加观察机制、A 档样本数量与判据
3. 规范修订两处（Phase 1 报告 §8，宜在 Phase 2 首个文档轮一起处理）：standards/07 验收节补"交付物表逐条核对"强制项；`tests/` 根级类型检查
4. 真实存量插件样本到位时：B1/B5 第二批复跑 + 边界表符号回填（不阻塞施工，阻塞"真实插件可迁移"表述）

> backlog（条件未触发，勿顺手做）：probe 通道、builtin 补偿动作、退避参数可配置面、migration 多步链、未决污染清单 CLI、Cell 池化、容器后端、分布式、观测生态与跨 run 读取（Phase 3）。

## 未决问题

- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- `throughSeq` 落地的载荷形状细节（`basedOn` 保留关键引用 + 新增上界字段 + schemaVersion 递增）在切片⑤设计稿定案——方向已由 ADR-0008 锁定

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 2 铁律**：D 档零例外已定——实现时任何"为了先跑起来"的兼容口子都属返工；映射不到就拒绝并留痕，替代写法进迁移手册
- **证据表述纪律**：合成组结果不得表述为"真实存量插件已验证"；两批材料在报告分开列（合同风险 1）
- **类型检查不得依赖构建产物**：新包 import workspace 兄弟包就要在它的 `tsconfig.json`（noEmit 那份）加 `paths`；**每轮收尾至少一次"`pnpm clean` 后跑全链"** → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)
- **跨包 import 运行期走 dist**：改 `packages/*/src` 不 rebuild 就跑 `tests/` → `x is not a function` → [P-002 规则 4](pitfalls/P-002-集成测试装配接线四类错.md)
- **集成测试装配接线四类错**（deps/opts 参数位、模块顶层捕获未初始化、依赖材料先于组件构造、dist 解析）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **CLI 资源收束覆盖所有 spawn 源** + **冷 Ledger 实例按 runId 拒接笔** → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- **Windows 子进程 exit 滞后 stdout 关闭**——死亡第一信号 = 通道关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **阶段验收执行法**（抽象主张 → 可断言口径；交付物表横向核对；证据行入报告）→ [S-001](skills/S-001-阶段验收执行法.md)
- 调度器是轮内事件唯一编排者但**非唯一写入者**：`AUTH_DENIED`/`EFFECT_*`/`STATE_SNAPSHOT_REF` 由组件直写，seq 连续但不入 `basedOn`——切片⑤前写归因断言按此事实设计
- 门禁链取真实退出码：`... | tail` 会把失败吞成 exit 0（用 `> log 2>&1; echo EXIT=$?`）；本地绿灯 ≠ CI 绿灯
- 文档红线：ADR 只增不改；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者
- cell 侧不持有 scope/runId（宿主盖章）；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022（无 Promise.withResolvers）
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-004）；方法索引：[skills/](skills/README.md)（S-001）
