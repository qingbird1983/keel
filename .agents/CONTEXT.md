# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：Phase 2 切片①施工收口 → 切片②设计稿成稿，草稿等所有者确认三项）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end` = a8b8444）；**Phase 2 🔄 进行中**（tag `phase-2.start`）
- **切片① ✅ 完成**（未单独打 tag）：运行期注册通道两 op + 承接层骨架 + A 档合成组 9 枚 + 四份验收测试，B1 三主张真实多进程通过；B5 只完成"合成组这一半"
- **切片② = 设计草稿**（`docs/design/phase-2/03-manifest-synthesis.md`，锚 B2/B6）：等所有者确认 §10 三项后转定稿；**本片实现代码一行未写**（铁律 1，§11 清单一步未动）
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（§7 六片、§5 B1~B8）；边界 `docs/design/phase-2/01-cordis-migration-boundary.md`（15 条，D 档零例外）；切片① `02-adapter-skeleton.md`（定稿 + 三处实现期细化 + §12 六条限制）；切片② `03-manifest-synthesis.md`（草稿）；`ADR-0010`、`ADR-0009`
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 = `qingbird1983`（ADR-0007）；CI 双 Node（22 / 26）；main = `fb013ac`（切片①合并）
- 门禁现状：六道全绿（`pnpm clean` 起）；**284 测试 / 36 文件**；零运行时三方依赖；最大实现文件 `core/src/scheduler.ts` 569 行（红线 600）；check-size 0 项提醒

## 上一轮完成了什么

- **切片①施工落地并推送**：`tool.register`/`tool.remove`（先裁决后写、版本内核指派、handler 不出舱）+ `permission-rules`（声明→规则，`allow` 可收窄）+ per-spawn `cellEntry` + 承接层 6 文件（Cell 内构造旧 ctx、两半提交带回滚、未映射一律抛）+ 9 枚样本与四份测试；A1 统一异步签名后复跑 3 次逐项一致（`events=708` 恒定）→ H-019、[P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)
- **切片②设计稿成稿**：先核六条事实（03 稿 §2，逐条指向源文件），再定方案——**两遍观察的声明合成路径**：pass 1 全拒（注册面全部来自 `AUTH_DENIED`）→ 候选 v1 → pass 2 只放行已被证明的下界（拿到 handler 内调用面）→ 候选 v2 + 缺项清单 → **人工审核转正**才进五步校验；被否五条（静态 AST / 观察期先放行 / 无单即拒 / 自动转正 / 替插件编补偿模板）
- **三条新暴露的接线缺口**（属事实核对，不是新 bug）：F2 CLI 的授权策略与 manifest 无关（写死 `p1` 全放行；`manifestAuthRules` 只有测试在用；`wireRun` 无 `cellEntry` → 承接层插件在 CLI 里跑不起来）；F3 `AssemblyManager` 只 spawn + 换绑、不 `serveCellChannel`，`cmd-hotswap` 从不起 run → "换绑后可用"是被默认相信的；F6 边界表 #4/#12 写的等价物在契约与 schema 里没有落点
- **切片① 登记的限制在本片收口**：就绪时机三方案对比，建议"装载门 + 既有 `cell.snapshot` 探测"（不加 op、不重新解释事件类），代价 = 需 ADR-0011 与契约 §3.1/§7 注记
- 文档与流水：03 稿登记进 docs/README、看板 Phase 2 行、CHANGELOG 0.1.027（施工轮）与 0.1.028（设计轮）、H-020 归档（裁 H-015）

## 下一步（按优先级，注明阻塞项）

1. **等所有者确认 03 稿 §10 三项**：① 就绪时机方案 A（并授权立 **ADR-0011**）；② 候选维持"必须人工审核转正"；③ 边界表 #4 → C、#12 → C/消解 的改档建议——**阻塞：等确认**
2. 确认后按 03 稿 §11 九步施工：ADR → 契约注记与 01 稿补注 → cell-runtime 装载门 → host `wireCell()` + `cellEntry` 透传 → adapter `synthesize`/`observe` → CLI `keel observe` + `buildRuntime` 接 `manifestAuthRules` → 六份测试（**先写红色断言**，铁律 7）→ B2/B6 集成与 B8 复跑 → 门禁与收尾四件事——**阻塞：第 1 项**
3. 规范修订两处仍待办（Phase 1 报告 §8）：standards/07 验收节补"交付物表逐条核对"强制项；`tests/` 根级类型检查
4. 工具链小项（非阻塞）：CI 的 `actions/checkout@v4` 等仍以 Node 20 为目标、`ubuntu-latest` 已迁 Ubuntu 26——下次动 CI 时一并升版本并固定 runner 标签
5. 真实存量插件样本到位时：B1/B5 第二批复跑 + 边界表符号回填（阻塞"真实插件可迁移"表述，不阻塞施工）；样本目录已排除统一格式化，真样本可原样落盘

> backlog（条件未触发，勿顺手做）：观察运行的人工参数注入、probe 通道、builtin 补偿动作、退避参数可配置面、未决污染清单 CLI、Cell 池化、容器后端、分布式、观测生态与跨 run 读取（Phase 3）。

## 未决问题

- 03 稿 §10 三项（见下一步第 1 条）
- "装配就绪"由谁提供：方案 A 改 Cell 应答语义（推荐）/ 方案 B 加第三个 op / 方案 C 启用事件类——三条都动到契约文档，只是深浅不同
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- `throughSeq` 载荷细节在切片⑤设计稿定案（方向已由 ADR-0008 锁定）
- Node 26 是否升为 `engines` 下限（当前 `>=22`；CI 矩阵已双覆盖，先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 2 铁律**：D 档零例外；映射不到就拒绝并留痕，替代写法进迁移手册。**合成产物不是报关单**——不以合成结果替代声明审核（合同 §6 风险 2）
- **观察不开越权窗口**：本片支点 = "拒绝本身就是一条完整事实"（`AUTH_DENIED` 的 `subject × action × resource`）；任何"先放行再看"的设计都违反 I4
- **证据表述纪律（三处硬约束）**：合成组结果不得表述为"真实存量插件已验证"；**B2 的硬拦截只覆盖经通道的写口**（`tool.register`/`tool.remove`），其它 cap 只到"规则按 allow 收窄"；`toolCallTimeoutMs` 拦不住同步忙等、舱内原生 `fetch`/`fs` 不被拦截（F4/F5 与 02 稿 §12 第 6 条）
- **承接层姿态**（02 稿 §3）：未映射旧面抛错给改法，绝不返回 undefined/空表；`ADAPTER/*` 只表示"旧面映射缺失"，裁决失败原样抛 Core 码
- **真实子进程测试要先立时序假设**：轮次瞬时、舱起飞上百 ms；屏障用既有可观测信号，放弃等待的条件写成证据 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)
- **"测试全过"不等于门禁过**：看 vitest 的 `Errors` 行与真实退出码；Promise 型资源释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)
- **类型检查不得依赖构建产物**：新包 import workspace 兄弟包就要补它的 `tsconfig.json`（noEmit 那份）`paths`；每轮收尾至少一次"`pnpm clean` 后跑全链" → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)
- **跨包 import 运行期走 dist**：改 `packages/*/src` 不 rebuild 就跑 `tests/` → `x is not a function` → [P-002 规则 4](pitfalls/P-002-集成测试装配接线四类错.md)
- **集成测试装配接线四类错**（deps/opts 参数位、模块顶层捕获未初始化、依赖材料先于组件构造、dist 解析）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)；**CLI 资源收束覆盖所有 spawn 源** + **冷 Ledger 按 runId 拒接笔** → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- **Windows 子进程 exit 滞后 stdout 关闭**——死亡第一信号 = 通道关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **阶段验收执行法**（抽象主张 → 可断言口径；交付物表横向核对；证据行入报告）→ [S-001](skills/S-001-阶段验收执行法.md)
- 调度器是轮内事件唯一编排者但**非唯一写入者**：`AUTH_DENIED`/`EFFECT_*`/`STATE_SNAPSHOT_REF` 由组件直写，seq 连续但不入 `basedOn`
- 门禁链取真实退出码：`... | tail` 会把失败吞成 exit 0（用 `> log 2>&1; echo EXIT=$?`）；本地绿灯 ≠ CI 绿灯
- 文档红线：ADR 只增不改；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"
- cell 侧不持有 scope/runId（宿主盖章）；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022（无 Promise.withResolvers）
- 工具变更传播口径：运行期注册**下一轮**才进决策输入；`discover` 稳定排序；分区是 **scope 级**，跨 run 不归零
- 合成 manifest 的字段约束：`meta.name` 必须 kebab-case（`^[a-z][a-z0-9-]*$`，大写会被规范化）、`version` 是 semver 精确值、越界能力必须带 `allow` 且补偿模板非空——**补偿模板合不出来，只能进缺项清单**
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-006）；方法索引：[skills/](skills/README.md)（S-001）
