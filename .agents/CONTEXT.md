# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：Phase 2 切片⑤施工 + 收口——契约修订与三项回填落地，**B7②③④⑤ 达成**、B8 全库复跑不退化）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end`）；**Phase 2 🔄 进行中**（tag `phase-2.start`）
- **切片① ✅**：运行期注册两 op + 承接层骨架 + A 档合成组；B1 三主张真实多进程通过
- **切片② ✅**：装载门（ADR-0011）+ `wireCell()` 收敛点 + 两遍观察合成 + `keel observe`；B2、B6 通过
- **切片③ ✅**：三个改法面 `ctx.model.invoke` / `ctx.effects.declare` / `ctx.ledger.read` + `guide` 第四桶 + 迁移手册首版；**B3 通过**
- **切片④ ✅**：策略舱独立进程 + `wirePolicies`（抢注整份拒、注册是最后一步、退出不级联）+ `keel run --policy-*`；**B4【一票否决】达成**、**B7① 达成**
- **切片⑤ ✅（本轮）**：`DECISION.throughSeq`（账本写入点盖章 + 类型级 `schemaVersion`）、快照落盘（`--snapshots`）、drain 确定次序（`DrainOutcome`）、`model.stream` 拉式三 op（ADR-0013）+ 承接层 `ctx.llm` 护栏 + `keel bench` B5a/B5b；**B7②③④⑤ 达成**，07 稿 §10 登记七处出入
- **当前 = 切片⑥**（真样本复跑、边界表符号闭环核对、开销基准复采、阶段验收与 `design/phase-2/report.md` 收口；锚 **B5【一票否决】+ B8**）
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（§5 B1~B8 现况：B3/B4/B7 已勾，B1/B2/B5/B6/B8 待切片⑥收口）；`01-…boundary.md`（#11 有一处待复核的字面出入）；`05-migration-handbook.md`（§1~§7 C 档改法、§8 D 档出路、**§9 快照、§10 流式**）；`06`（§9 六条限制 + §10 施工记录）；`07`（§9 六条限制 + §10 七条施工记录）；ADR-0010/0011/0012/0013（各含实施注记）
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 `qingbird1983`（ADR-0007）；CI 双 Node（22/26）
- 门禁现状：六道全绿（`pnpm clean` 起，逐条取真实退出码）；**431 测试 / 53 文件**；零运行时三方依赖；最大实现文件仍是 `core/src/scheduler.ts` 569 行（红线 600；`apps/keel/src/runtime.ts` 456、`core/src/gateway.ts` 450）；check-size 0 项提醒（docs 42 篇）

## 上一轮完成了什么

- **红测先行**：`tests/snapshot-cross-host.test.ts` 的跨宿主恢复在实现前红在 `RECOVER/SNAPSHOT-MISSING`（红先于实现存在，才证得了实现满足主张）；流式那条红在"首页只回 `chunks:[]`"
- **归因上界**：`Ledger.append(..., {stampSeqBeforeAs})` 在写队列执行期盖章；`EVENT_SCHEMA_VERSION` 按类型递增；`keel replay` 对新账本打 `throughSeq=N`、对 Phase 1 样例明打"无显式上界"，稠密性哨兵 `throughSeq === seq-1` 有断言钉着
- **快照与收尾**：`SnapshotStore` 落盘（先内容后引用、tmp+rename、冷启动接续版本号、不可表示值即抛）；drain = 拒新（`SCHED/BACKPRESSURE`）→ 等在途 → 既有宽限强杀，产物是 `DrainOutcome`；**`kill()` 转为公开原语**（A3 与 scenario a3 要的是硬中断，不是 drain）
- **流式**：`core/src/stream.ts` 会话表 + 网关三面（授权一次 / 预扣一次 / `MODEL_INVOKED` 一条含 `streamId` / 每片不写事件 / 终局 settle），四条终局全部闭环；`model.adapter` 编译出两条动作；三 op 跨 stdio 的真进程证据在 `tests/model-stream-channel.test.ts`
- **文档**：契约 01 稿七处注记（含 §12 关闭"背压与断流"）；ADR-0008 四条 + ADR-0013 六条实施注记；Phase 1 报告限制 2/4 关闭注记 + A8 两行新数据；01 稿 #6 注记（档位未动）；05 手册新增 §9/§10；07 稿 §8 打勾 + §10；合同 §5 B7 勾选；CHANGELOG 0.1.039

## 下一步（按优先级，注明阻塞项）

1. **切片⑥**：真样本到位后 B1/B5 第二批复跑 + 01 稿 §5 符号回填义务；边界表符号闭环机械核对（`tests/cordis-symbol-scan.test.ts` 扩）；开销基准复采（含承接层开销与 B5 两行）；`docs/design/phase-2/report.md` 阶段验收收口 → 满足后由**所有者**决定是否打 `phase-2.end`
2. **切片⑥开工前先解决的形状问题**：`gateway.ts` 450 行——再往网关加面（如续流、多上游路由）就**先拆**，别贴着 600 收口
3. **待所有者处置**：01 稿 #11 的 B/C 字面出入（`ledger.read` 不需声明、manifest 无对应字段，而插件方确实要改一行）——只登记，不自改判
4. 老边界（未触发勿动）：回滚是否回收共享分区里新舱的注册（动 ADR-0010 版本唯一事实源，需评审）；06 稿 §9 限制 2（`paramsDigest` 实为参数全文，策略因此看得见参数）
5. 规范修订两处仍待办（Phase 1 报告 §8）：standards/07 验收节补"交付物表逐条核对"强制项；**根 `tests/` 与 `apps/*/test` 的类型检查缺口**——本轮 P-011 第二次复发正落在这个缺口上，补上就能把这类错拦在提交前
6. 工具链小项（非阻塞）：CI `actions/checkout@v4` 仍以 Node 20 为目标、`ubuntu-latest` 已迁 Ubuntu 26——下次动 CI 一并升版本并固定 runner 标签

> backlog（条件未触发，勿顺手做）：流式计时断流的真进程覆盖（要先给时限开交付面参数）、同步忙等的物理强杀口径（与容器后端一起评）、Cell 池化、容器后端、builtin 补偿动作、probe 通道、未决污染清单 CLI、观测生态与跨 run 读取（Phase 3）、策略热更新（ADR-0012 重评条件 ②）。

## 未决问题

- 01 稿 #11 的档位（B 还是 C）待所有者复核
- "回滚是否应回收共享分区里新舱的注册"——需要版本回退语义，动 ADR-0010，待评审
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- Node 26 是否升为 `engines` 下限（当前 `>=22`；CI 矩阵已双覆盖，先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **`kill()` 与 `drainAndReap()` 是两件事**（切片⑤起）：drain = 拒新 + 等在途 + 宽限强杀；`kill()` = OS 级硬中断、不等任何东西。**"在途被打断"这个前提只能由 `kill()` 造**，用它 = 在测试注释里写清是哪一个 → [P-010](pitfalls/P-010-旧原语加新语义让调用点前提消失.md)
- **跨边界序列化会静默丢东西**：`JSON.stringify` 对函数/symbol/`bigint` 是**丢掉**不是抛（`snapshot()` 的隐含约束，已写进 05 手册 §9）；跨包错误体只按结构（`code`/`detail`）识别，`instanceof` 在包界外必然失灵 → [P-009](pitfalls/P-009-跨边界序列化会静默丢东西.md)。**这类坑只有真进程测试能看见**，单测全绿不构成证据
- **中文标题里的 ASCII 双引号会截断字符串**，且根 `tests/` 不进类型检查 → 写完测试跑 P-011 里那条机械检查（"下次注意"已被证伪两次）→ [P-011](pitfalls/P-011-中文文案里的ASCII双引号截断字符串.md)
- **流式的记账四条不变式不许松**：授权一次、预扣一次、`MODEL_INVOKED` 一条（含 `streamId`）、**每片不写事件**、终局 settle（无 settle 不算完成）。断流按已产出部分结算 + `truncated:true`；一片没出的断流 = 失败但仍闭环；**上游抛 ≠ 慢**：抛要报错，不把半截答案标成 `done:true`。时限只有契约 §7 那两个数，CLI 没有注入参数
- **归因链的表述**：依据 = `DECISION.basedOn`（关键引用，不枚举），信息上界 = `throughSeq` 之前的一切（含直写事件）。信封 `schemaVersion` 是**按类型**的表，读方不得因缺字段报错，也不能把"缺字段"读成"内核漏写"
- **Phase 2 铁律**：D 档零例外；映射不到就拒绝并留痕，替代写法进迁移手册；**合成产物不是报关单**（不自动转正）；**改法面不是旧面改名**（`guide` 塞进 `mapped` = 把 C 档谎报成 A 档，B5 一票否决的漂移形态）；承接层**不替旧框架发明 API**（护栏只给去处，不给边界表加行）
- **内核拥有的量不接受临场指定**：`effectId` 由 Cell 侧指派、`actionRef`/`idempotency`/`probeRef` 由报关单决定、`runId` 与授权主体由通道盖章、工具版本号由内核指派——插件传了就拒，不做"收到但忽略"
- **真实子进程测试**：轮号不是稳定量（装载屏障吃空转轮）→ [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)；**终态是第一条断言**，屏障期死亡的 run 必须留违规 → [P-008](pitfalls/P-008-屏障期死亡与空违规表.md)；**绿色要当场验真** → [P-007](pitfalls/P-007-测试绿色要当场验真.md)
- **"测试全过"不等于门禁过**：看真实退出码（`> log 2>&1; echo EXIT=$?`，不要 `| tail`）；释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)；多参构造先读签名（deps vs opts）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **跨包 import 运行期走 dist**：改 `packages/*/src` 不 rebuild 就跑 `tests/` 会 `x is not a function` → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)；构建只在 `tests/fixtures/global-setup.ts` 做一次；Windows 子进程 exit 滞后 stdout 关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)；CLI 收束与冷 Ledger 接笔 → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- 权限面只有一个来源：Cell 可见面一律来自 `manifestAuthRules`（`model.adapter` 现在编译出 `model.invoke` + `model.stream` 两条）；`tool.invoke` 是宿主自己的执行放行，改任何一侧都要同步 `runPolicy`；**换 `agentId` = 换授权主体**，跨域用 scope（`sessionId`）
- 调度器是轮内事件唯一编排者但**非唯一写入者**；分区是 **scope 级**，跨 run 不归零；工具变更**下一轮**才进决策输入；seq 是 Run 内单调（稠密性有哨兵断言）；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022
- 文档红线：ADR 只增不改（**追加带日期的实施注记**是允许的补正路径，本轮 ADR-0008/0013 都用了）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"；handoff 滚动 5 份
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-011）；方法索引：[skills/](skills/README.md)（S-001）
