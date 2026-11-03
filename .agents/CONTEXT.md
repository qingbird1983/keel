# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：Phase 2 切片③施工 + 收口——C 档三条改法地面落地、迁移手册首版，B3 通过）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end`）；**Phase 2 🔄 进行中**（tag `phase-2.start`）
- **切片① ✅**：运行期注册两 op + 承接层骨架 + A 档合成组 + B1 三主张真实多进程通过
- **切片② ✅**：装载门（ADR-0011）+ `wireCell()` 收敛点 + 两遍观察合成 + `keel observe` + 声明编译接进正式接线；B2、B6 通过
- **切片③ ✅（本轮）**：三个改法面 `ctx.model.invoke` / `ctx.effects.declare` / `ctx.ledger.read`（全部映射既有 op，零新 op、零新错误码、零契约改动）+ `guide` 第四桶 + 旧插件补偿表/快照面登记 + `actionSpec.cellEntry` + 三对真进程样本 + 迁移手册首版；**B3 通过**，B8 复跑全绿
- **当前 = 切片④设计稿**（锚 **B4 + B7①**：崩溃分类与 D 档装配链）——铁律 1：稿未定稿前不写实现代码
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（§7 六片、§5 B1~B8）；边界 `01-cordis-migration-boundary.md`（B 档只剩 #5/#11，#11 有一处待复核的字面出入）；`02`（切片①）/`03`（切片②）/`04`（切片③，§11 是施工期偏差）/`05-migration-handbook.md`（手册）；`ADR-0010`、`ADR-0011`
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 `qingbird1983`（ADR-0007）；CI 双 Node（22/26）；**main = `5e5279c`**（切片③定稿合并点；本轮施工在其后）
- 门禁现状：六道全绿（`pnpm clean` 起）；**338 测试 / 44 文件**；零运行时三方依赖；最大实现文件 `core/src/scheduler.ts` 569 行（红线 600）；check-size 0 项提醒（docs 38 篇）

## 上一轮完成了什么

- **改法地面三条**：`core.ts` 定义 `CordisModelRequest`/`CordisEffectDecl`/`CordisLedgerFilter` + `CordisGuidePort` + `CordisPorts`；`cell-port.ts` 映射 `CellClient` 的 `model.invoke`/`effect.declare`/`ledger.read`；`host-port.ts` 的三面统一抛 `ADAPTER/PORT-UNSUPPORTED`（F7：诊断端口不假装能跑真链路）
- **归属校验在映射期做完**：缺 `reqId`/`estimate`/`effectKind` 即拒且**不发帧**；插件试图自带 `effectId`/`compensation`/`probeRef` 或 `ledger.read({runId})` 即拒（`ADAPTER/ARGS-REQUIRED`）——补偿动作与幂等口径归报关单，run 由宿主盖章
- **旧插件的补偿表与快照面**：`normalizeLegacyExtras` 认 `module.exports.compensations` / `.snapshot`（含函数导出挂属性形状），坏形状 `ADAPTER/SHAPE-INVALID` 装载期即拒，**无导出 = 不登记**（不登记空表，保住 `CELL/ACTION-UNKNOWN` 的归因）
- **回滚入口位补齐**：`apps/keel/runtime.ts` 的 `actionSpec.cellEntry` 透传 `spawnCell`；rig 的补偿动作舱同走承接层入口——旧插件的回滚闭环这才真走得通
- **B3 证据**：`tests/cordis-c-surface.test.ts` 7 条（#6 上游一次 + 四组账本事件各一条 + 第二次 `replay:true`；#8 两域互不可见而值换舱；#9 报关→失败→新舱执行补偿→重派不重复；反向：未报关 `model.adapter` → `AUTH/DENIED`）
- **文档**：01 稿六行实现期注记（档位未动）+ 04 稿 §9 打勾、§10 第 7 条、§11 六条偏差记录；手册首版；CHANGELOG 0.1.033 / 看板 / H-022 / **P-008** 全部登记

## 下一步（按优先级，注明阻塞项）

1. **切片④设计稿**：B4（崩溃分类可见 + "静默降级即验收失败"的核对法）+ B7①；含 D 档两条的装配链证据（合同 §6 风险 3：策略插件 → hook 总线未接通）；开工先做事实核对（`04` 稿 §11 与 `03` 稿 §12 已列的边界要一并处置或明确推后）
2. **待所有者处置**：01 稿 #11 的 B/C 字面出入（`ledger.read` 不需声明、manifest 无对应字段，而插件方确实要改一行代码）——本轮只登记，不自改判
3. 未决的老边界：**回滚是否回收共享分区里新舱的注册**（动 ADR-0010 版本唯一事实源，需评审）；`throughSeq`/快照物理持久化（切片⑤）；真样本到位后 B1/B5 第二批复跑 + 符号回填（阻塞"真实插件可迁移"表述，不阻塞施工）
4. 规范修订两处仍待办（Phase 1 报告 §8）：standards/07 验收节补"交付物表逐条核对"强制项；根 `tests/` 与 `apps/*/test` 的类型检查缺口（现由 P-007 的顺序纪律替代）
5. 工具链小项（非阻塞）：CI `actions/checkout@v4` 仍以 Node 20 为目标、`ubuntu-latest` 已迁 Ubuntu 26——下次动 CI 一并升版本并固定 runner 标签

> backlog（条件未触发，勿顺手做）：观察运行的人工参数注入、probe 通道、builtin 补偿动作、退避参数可配置面、未决污染清单 CLI、Cell 池化、容器后端、分布式、观测生态与跨 run 读取（Phase 3）、activation 期调用新面的真实形态（等真样本暴露）。

## 未决问题

- 01 稿 #11 的档位（B 还是 C）待所有者复核
- "回滚是否应回收共享分区里新舱的注册"——需要版本回退语义，动 ADR-0010，待切片④/⑤评审
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- Node 26 是否升为 `engines` 下限（当前 `>=22`；CI 矩阵已双覆盖，先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 2 铁律**：D 档零例外；映射不到就拒绝并留痕，替代写法进迁移手册（手册 = `docs/design/phase-2/05`）。**合成产物不是报关单**——不给自动转正；**改法面不是旧面改名**——把 `guide` 塞进 `mapped` 就是把 C 档谎报成 A 档（B5 一票否决的漂移形态）
- **归属链只有一个方向**：裁决失败原样抛 Core 码（`AUTH/DENIED`、`SCHED/MANIFEST-INVALID`、`BUDGET/EXHAUSTED`），承接层不改写；`ADAPTER/*` 只表示"映射期/装载期本地错误"（新增两枚：`ADAPTER/ARGS-REQUIRED`、`ADAPTER/SHAPE-INVALID`，仍不入 Core 词表、不落账本、不过通道）
- **内核拥有的量不接受临场指定**：`effectId` 由 Cell 侧指派、`actionRef`/`idempotency`/`probeRef` 由报关单决定、`runId` 由通道盖章、版本号由内核指派——插件传了就拒，**不做"收到但忽略"**（忽略等于假装拦截成功）
- **权限面只有一个来源**：Cell 可见面一律来自 `manifestAuthRules`；`tool.invoke`/`model.invoke` 是宿主自己的执行放行，改任何一侧都要同步 `runPolicy`；**换 `agentId` = 换授权主体**，跨域用 scope（`sessionId`）而不是换主体 → [P-008](pitfalls/P-008-屏障期死亡与空违规表.md)
- **证据表述纪律**：合成组结果不得表述为"真实存量插件已验证"；舱内原生 `fetch`/`fs` 与模型 SDK 直调**观察不到**（02 稿 F4），只能写缺项；`toolCallTimeoutMs` 拦不住同步忙等
- **真实子进程测试**：先写时序假设 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)；**终态是第一条断言**，屏障期死亡的 run 必须留下违规（rig 已在 `probe.done` 永久补上）→ [P-008](pitfalls/P-008-屏障期死亡与空违规表.md)；**绿色要当场取证** → [P-007](pitfalls/P-007-测试绿色要当场验真.md)
- **"测试全过"不等于门禁过**：看真实退出码（`> log 2>&1; echo EXIT=$?`，不要 `| tail`）；释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)
- **跨包 import 运行期走 dist**：改 `packages/*/src` 不 rebuild 就跑 `tests/` 会 `x is not a function` → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)、[P-002 规则 4](pitfalls/P-002-集成测试装配接线四类错.md)；**构建只在 `tests/fixtures/global-setup.ts` 做一次**（并发重建会随机做红）
- **CLI 资源收束 + 冷 Ledger 接笔** → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)；**Windows 子进程 exit 滞后 stdout 关闭** → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **阶段验收执行法**（抽象主张 → 可断言口径；交付物表横向核对；证据行入报告）→ [S-001](skills/README.md)
- 调度器是轮内事件唯一编排者但**非唯一写入者**（`AUTH_DENIED`/`EFFECT_*`/`STATE_SNAPSHOT_REF`/`MODEL_*`/`BUDGET_*` 由组件直写）；分区是 **scope 级**，跨 run 不归零；工具变更**下一轮**才进决策输入；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022
- 文档红线：ADR 只增不改；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"；handoff 滚动 5 份
- 合成 manifest 的字段约束：`meta.name` kebab-case、`version` semver 精确、越界能力必须带 `allow` 且补偿模板非空——**补偿模板合不出来只能进缺项清单**
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-008）；方法索引：[skills/](skills/README.md)（S-001）
