# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：Phase 2 切片②施工 + 收口——合成路径、权限收敛、升级接缝落地，B2/B6 通过）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end`）；**Phase 2 🔄 进行中**（tag `phase-2.start`）
- **切片① ✅**（合并 `fb013ac`）：运行期注册两 op + 承接层骨架 + A 档合成组 + B1 三主张真实多进程通过
- **切片② ✅（本轮）**：装载门 + `wireCell()` 收敛点 + 投影纯函数 + 两遍观察 + `keel observe` 命令 + 声明编译接进正式接线；**B2、B6 通过**，B8 复跑全绿。设计稿 `03-manifest-synthesis.md` 状态 = 施工完成
- **当前 = 切片③ 设计稿**（C 档三条改法与迁移手册，锚 B3）——铁律 1：稿未定稿前不写实现代码
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（§7 六片、§5 B1~B8）；边界 `01-cordis-migration-boundary.md`（#4/#12 已改判 C，B 档只剩 #5/#11）；`02-adapter-skeleton.md`（切片①）；`03-manifest-synthesis.md`（切片②）；`ADR-0010`、`ADR-0011`
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 `qingbird1983`（ADR-0007）；CI 双 Node（22/26）；**main = `09b8416`**（本轮切片②待合并）
- 门禁现状：六道全绿（`pnpm clean` 起）；**311 测试 / 41 文件**；零运行时三方依赖；最大实现文件 `core/src/scheduler.ts` 569 行（红线 600）；check-size 0 项提醒

## 上一轮完成了什么

- **就绪时机转正（ADR-0011 落地）**：`startCell` 增 `loadGate`，默认入口在装载末尾 `markReady()`，承接层入口在 `await activate(ctx)` 之后开闸；宿主以一次既有查询 `cell.snapshot` 作就绪凭据——**单次、不重试**，等不到就 `dispose` 该舱并明确拒绝装配。不加 op、不改事件语义、不改生命周期阶段
- **装配收敛点 `packages/host/src/wire-cell.ts`**：`起舱 → 绑通道 → 建分区 → 探就绪`一处做完；`wireRun`、B6 的工厂共用它；`CellFactory`/`BindRequest`/`HotSwapRequest` 透传 `cellEntry`（消解开工事实 F3：**换绑之后第一次真的起了 run**）
- **两遍观察 → 候选 + 缺项清单**：`host/manifest-synthesis.ts`（账本事实 → 投影，排序去重保证两次观察字节一致；越界能力与观察不到的面**一律进缺项**，补偿模板绝不代造）；`apps/keel/src/observe.ts`（pass 1 全拒拿注册面 → pass 2 只放行已证明的下界拿 handler 内部面）；`keel observe` 落 `<name>.candidate.json` + `<name>.gaps.md`，退出码 = 能否过五步校验；**候选不自转正**
- **权限收敛接进正式接线（消解 F2）**：`runPolicy(manifest, subject)` = `manifestAuthRules` + 宿主自身 `tool.invoke`/`model.invoke`；`keel run` 走报关单策略，写死的 `p1` 退为场景/benchmark 的显式选项
- **测试与文档**：新增 6 份测试（含先红的 B2 集成）+ B 档样本 5 枚并入零改动机械判据；03 稿 §11 打勾、§12 追加第 6~9 条限制、§9 改写 rig 屏障结论；看板/CHANGELOG 0.1.030/H-021/P-007 全部登记

## 下一步（按优先级，注明阻塞项）

1. **切片③ 设计稿**：C 档三条改法（配置密钥 → 声明能力由内核代持；跨插件依赖 → 显式调用或读只读账本；日志 → 读账本）+ 迁移手册结构与样本，锚 B3；**本片不做**：`throughSeq`/快照持久化/drain/流式（⑤）、真样本复跑与报告收口（⑥）
2. 切片③稿里要顺手处置本轮登记的边界（03 稿 §12 第 6~8 条）：装载完成 ≠ 注册落进共享分区；回退不回收新舱写进分区的同名条目（要补得动 ADR-0010 的版本唯一事实源，需要评审而非顺手改）
3. 规范修订两处仍待办（Phase 1 报告 §8）：standards/07 验收节补"交付物表逐条核对"强制项；根 `tests/` 与 `apps/*/test` 的类型检查缺口（本轮由 P-007 补了顺序纪律作替代）
4. 工具链小项（非阻塞）：CI 的 `actions/checkout@v4` 仍以 Node 20 为目标、`ubuntu-latest` 已迁 Ubuntu 26——下次动 CI 一并升版本并固定 runner 标签
5. 真实存量插件样本到位时：B1/B5 第二批复跑 + 边界表符号回填（阻塞"真实插件可迁移"表述，不阻塞施工）；样本目录已排除统一格式化，真样本可原样落盘

> backlog（条件未触发，勿顺手做）：观察运行的人工参数注入、probe 通道、builtin 补偿动作、退避参数可配置面、未决污染清单 CLI、Cell 池化、容器后端、分布式、观测生态与跨 run 读取（Phase 3）。

## 未决问题

- "回滚是否应回收共享分区里新舱的注册"——需要版本回退语义，动 ADR-0010 单一事实源，待切片③/④评审
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- `throughSeq` 载荷细节在切片⑤设计稿定案（方向已由 ADR-0008 锁定）
- Node 26 是否升为 `engines` 下限（当前 `>=22`；CI 矩阵已双覆盖，先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 2 铁律**：D 档零例外；映射不到就拒绝并留痕，替代写法进迁移手册。**合成产物不是报关单**——不给自动转正，也不给"看起来安全"的特例（合同 §6 风险 2 按原文执行）
- **观察不开越权窗口**：支点 = "拒绝本身就是一条完整事实"（`AUTH_DENIED` 的 `subject × action × resource × policyVersion`）；任何"先放行再看"的设计违反 I4。观察趟**走显式接线**，不走 `wireCell()`——pass 1 的产物恰恰是"舱在拒绝下崩掉"（03 稿 §12 第 7 条）
- **证据表述纪律**：合成组结果不得表述为"真实存量插件已验证"；B2 硬拦截只覆盖经通道的写口（`tool.register`/`tool.remove`）；舱内原生 `fetch`/`fs` 与模型 SDK 直调**观察不到**，只能写缺项，不得写成"已确认不需要"；`toolCallTimeoutMs` 拦不住同步忙等
- **权限面只有一个来源**：Cell 可见面（`tool.register`/`tool.remove`/`net.fetch`/`fs.*`/`model.invoke`）一律来自 `manifestAuthRules`，未声明 = 无规则 = 当场拒并留痕；`tool.invoke`/`model.invoke` 是宿主自己的执行放行，不由报关单产出，改任何一侧都要同步 `runPolicy`
- **承接层姿态**（02 稿 §3）：未映射旧面抛错给改法，绝不返回 undefined/空表；`ADAPTER/*` 只表示"旧面映射缺失"，裁决失败原样抛 Core 码；错误码是封闭集合——本轮就因此把 `CELL/NOT-READY` 换成 `TRANSPORT/TIMEOUT` + `detail.reason`
- **真实子进程测试**：先写时序假设，屏障用既有可观测信号，放弃等待写成证据 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)；**绿色要当场取证**（新写/大改测试后 prettier → eslint → 跑该文件 → 全库跑一次）→ [P-007](pitfalls/P-007-测试绿色要当场验真.md)
- **"测试全过"不等于门禁过**：看 vitest 的 `Errors` 行与真实退出码（`> log 2>&1; echo EXIT=$?`，不要 `| tail`）；Promise 型资源释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)
- **类型检查不得依赖构建产物**；**跨包 import 运行期走 dist**——改 `packages/*/src` 不 rebuild 就跑 `tests/` 会 `x is not a function` → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)、[P-002 规则 4](pitfalls/P-002-集成测试装配接线四类错.md)
- **集成测试装配接线五类错**（参数位、模块顶层捕获未初始化、材料先于组件构造、dist 解析、**并发重建抢产物**）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)：**构建只在 `tests/fixtures/global-setup.ts` 做一次**，测试文件里不许再出现 `execSync("pnpm build")`（10 个 worker 并发重建会把门禁随机做红）；**CLI 资源收束覆盖所有 spawn 源** + **冷 Ledger 按 runId 拒接笔** → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- **Windows 子进程 exit 滞后 stdout 关闭**——死亡第一信号 = 通道关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **阶段验收执行法**（抽象主张 → 可断言口径；交付物表横向核对；证据行入报告）→ [S-001](skills/README.md)
- 调度器是轮内事件唯一编排者但**非唯一写入者**：`AUTH_DENIED`/`EFFECT_*`/`STATE_SNAPSHOT_REF` 由组件直写，seq 连续但不入 `basedOn`；分区是 **scope 级**，跨 run 不归零；工具变更**下一轮**才进决策输入
- cell 侧不持有 scope/runId（宿主盖章）；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022（无 `Promise.withResolvers`）
- 文档红线：ADR 只增不改；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"
- 合成 manifest 的字段约束：`meta.name` 必须 kebab-case（大写被规范化，故加 `legacy-` 前缀）、`version` 是 semver 精确值、越界能力必须带 `allow` 且补偿模板非空——**补偿模板合不出来，只能进缺项清单**
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-007）；方法索引：[skills/](skills/README.md)（S-001）
