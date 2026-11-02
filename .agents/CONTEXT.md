# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：Phase 2 切片①设计稿成草稿 → 收尾核对拦下并修复账本浮空 close 缺陷）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end` = a8b8444）：A1~A8 逐条实测，一票否决五项全过，证据在 `docs/design/phase-1/report.md`
- **Phase 2 🔄 切片① 设计阶段**（tag `phase-2.start`）：范围合同与迁移边界文档已定稿；**切片①设计稿 = 草稿**（`docs/design/phase-2/02-adapter-skeleton.md`），等所有者确认稿内 §10 三项后转定稿；**仍未写本片实现代码**（铁律 1）
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（§7 六片切分）；边界 `docs/design/phase-2/01-cordis-migration-boundary.md`（14 条 A/B/C/D + D 档零例外）；本片口径 `docs/design/phase-2/02-adapter-skeleton.md`；`ADR-0008`（切片⑤落地）
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 = `qingbird1983`（ADR-0007）；**CI 双 Node 矩阵首跑均绿**（run 41484129249：Node 22 1m6s / Node 26 1m34s）
- 门禁现状：六道全绿（`pnpm clean` 起）；226 测试 / 30 文件；零运行时三方依赖；单文件最大仍在 600 红线内；check-size 0 项提醒

## 上一轮完成了什么

- **切片①设计稿成稿**（草稿 228 行）：先核四条起点事实（F1 Core 可见工具表在正式接线上从未由插件填充、F2 适配原型只在宿主进程构造、F3 能力词表不参与运行期裁决、F4 进程后端不拦截舱内原生 `fetch`/`fs`），再定方案
- **四处定案**：① seam = 承接层自带 Cell 入口，宿主 per-spawn 换 `cellEntry`（`spawnCell`/bootstrap 形状不变）；② 注册链路 = 新增 `tool.register`/`tool.remove` 两个 Cell→Core op，**先写 Cell 执行表、后写 Core 分区、失败回滚**，版本号由 Core 指派（`@keel/core` 零改动）；③ 能力门禁 = 新模块 `permission-rules.ts` 把 manifest 声明编译成授权规则（拒绝自动落 `AUTH_DENIED`）；④ 同步/异步 = Cell 侧 `ctx.tools.*` 返回 Promise，明确拒绝"同步返回 + 后台 flush"（那是静默降级）
- **A 档合成样本组设计**：5 常规 + 4 最坏写法探针（动态 require / 原型链 / 进程级全局 / 加载顺序），零改动五条机械判据（`.cjs`、源码无 `@keel/` 与 Keel 符号、装载不改写、为过测试改样本即作废、符号必须命中承接面清单），driver 改**断言式**（只从可见表选工具，预期缺席即失败）
- **修掉一处真实缺陷（先红后修，两个同源口子）**：`Ledger.rollSegment()` 的 close 未 await → 关闭时机交给 GC，Node 24+ 判硬错误；现象是"226 项断言全过但 `pnpm test` exit=1（`Errors 1 error`）"且偶发（CI 的 Node 22 静默）。另：几处测试手工 `new Ledger` 未登记 close = 同一报错的第二个出处。已改 `await closing.close()`（失败锁存 fail-stop）+ rig 一律"构造即登记"，新增环境无关防回归测试，CI 改 Node `[22, 26]` 矩阵，standards/04 §3 补"Promise 型释放必须 await"；全套连跑 2 次 + 目标文件 3 次复验稳定 → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)
- 文档与知识库：docs/README 登记 02 稿、看板 Phase 2 行更新、CHANGELOG 0.1.025（并修 0.1.020 的排序错位）、H-018 归档（裁 H-013）、P-005 新增

## 下一步（按优先级，注明阻塞项）

1. **等所有者确认 02 稿 §10 三项** → 转定稿：① 是否授权立 **ADR-0010**（新增两个 Cell→Core op + `tool.provide` 语义从"装载期清单"扩到"运行期注册"，同步契约 §3.3/§4.6 与 manifest §5.2 注记；ADR 只增不改，故定稿后才写；0009 已被本轮资源释放规范补条占用）；② 边界表 #1/#2 两条补注（返回值同步消费属 C 档一行 `await`；"启动期塞钩子"归 #14 D 档）；③ 样本组规模 9 枚是否合适 + 是否新增行 #15 `ctx.bus.emit/on`（建议 C 档）——**阻塞：等确认**
2. 确认后按 02 稿 §11 顺序施工（ADR → 契约/manifest/边界注记 → cell-runtime 两方法 + `CellHandle.removeTool` → host 两 op case + per-spawn 入口 + `permission-rules` → adapter 端口与 Cell 入口 → §8 五份测试；新链路先写红色断言，铁律 7）——**阻塞：第 1 项**
3. A1 端口签名统一（3 处 `await`）后**复跑 3 次逐项一致**（B8"Phase 1 主张不退化"的一部分）
4. 规范修订两处仍待办（Phase 1 报告 §8）：standards/07 验收节补"交付物表逐条核对"强制项；`tests/` 根级类型检查
5. 工具链小项（本轮 CI 首跑的提示，非阻塞）：`actions/checkout@v4`/`setup-node@v4`/`pnpm/action-setup@v4` 仍以 Node 20 为目标（runner 已强制切 24，流水线有弃用提示）；`ubuntu-latest` 已于 2026-10-19 迁 Ubuntu 26——下次动 CI 时一并升版本并把运行器标签固定，避免"某天突然红"
6. 真实存量插件样本到位时：B1/B5 第二批复跑 + 边界表符号回填（不阻塞施工，阻塞"真实插件可迁移"表述）

> backlog（条件未触发，勿顺手做）：probe 通道、builtin 补偿动作、退避参数可配置面、migration 多步链、未决污染清单 CLI、Cell 池化、容器后端、分布式、观测生态与跨 run 读取（Phase 3）。

## 未决问题

- 02 稿 §10 三项（见下一步第 1 条）
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- `throughSeq` 载荷形状细节在切片⑤设计稿定案（方向已由 ADR-0008 锁定）
- Node 26 是否升为 `engines` 下限（当前 `>=22`；CI 矩阵已双覆盖，先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 2 铁律**：D 档零例外已定——任何"为了先跑起来"的兼容口子都属返工；映射不到就拒绝并留痕，替代写法进迁移手册
- **承接层姿态**（02 稿 §3）：未映射的旧面**抛错给改法**，绝不返回 undefined/空表；`ADAPTER/*` 只表示"旧面映射缺失"，运行期裁决失败原样抛 Core 码，归因指向内核
- **证据表述纪律**：合成组结果不得表述为"真实存量插件已验证"；F4（舱内原生 `fetch`/`fs` 不被拦截）约束 B1/B2 的措辞；两批材料在报告分开列
- **"测试全过"不等于门禁过**：vitest 的 `Errors` 行 + 真实退出码才算数；Promise 型资源释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)
- **类型检查不得依赖构建产物**：新包 import workspace 兄弟包就要在它的 `tsconfig.json`（noEmit 那份）加 `paths`；**每轮收尾至少一次"`pnpm clean` 后跑全链"** → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)
- **跨包 import 运行期走 dist**：改 `packages/*/src` 不 rebuild 就跑 `tests/` → `x is not a function` → [P-002 规则 4](pitfalls/P-002-集成测试装配接线四类错.md)
- **集成测试装配接线四类错**（deps/opts 参数位、模块顶层捕获未初始化、依赖材料先于组件构造、dist 解析）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **CLI 资源收束覆盖所有 spawn 源** + **冷 Ledger 实例按 runId 拒接笔** → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- **Windows 子进程 exit 滞后 stdout 关闭**——死亡第一信号 = 通道关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **阶段验收执行法**（抽象主张 → 可断言口径；交付物表横向核对；证据行入报告）→ [S-001](skills/S-001-阶段验收执行法.md)
- 调度器是轮内事件唯一编排者但**非唯一写入者**：`AUTH_DENIED`/`EFFECT_*`/`STATE_SNAPSHOT_REF` 由组件直写，seq 连续但不入 `basedOn`——切片⑤前写归因断言按此事实设计
- 门禁链取真实退出码：`... | tail` 会把失败吞成 exit 0（用 `> log 2>&1; echo EXIT=$?`）；本地绿灯 ≠ CI 绿灯
- 文档红线：ADR 只增不改；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"
- cell 侧不持有 scope/runId（宿主盖章）；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022（无 Promise.withResolvers）
- 工具变更传播口径：运行期注册**下一轮**才进决策输入（`consumeSchemaChanges` 在轮边界取走）；`discover` 稳定排序 → 缓存键不受注册顺序影响
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-005）；方法索引：[skills/](skills/README.md)（S-001）
