# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：Phase 2 切片⑥ 第一批——三枚真实第三方 Cordis 插件的取回、观察与登记；**B5 判为未通过**）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end`）；**Phase 2 🔄 进行中**（tag `phase-2.start`）
- **切片① ✅** 承接层骨架 + B1；**② ✅** 装载门（ADR-0011）+ 声明合成 + B2/B6；**③ ✅** 三条 C 档改法面 + B3 + 手册首版；**④ ✅** 策略舱 + `wirePolicies` + **B4【一票否决】** + B7①；**⑤ ✅** 契约修订与三项回填（`throughSeq` / 快照落盘 / drain / `model.stream`）+ **B7②③④⑤**，B8 复跑 431 项/53 文件全绿
- **当前 = 切片⑥**（真样本复跑、边界表符号闭环、开销基准复采、阶段验收与 `design/phase-2/report.md` 收口；锚 **B5【一票否决】+ B8**）
- **本轮交付第一批真样本，B5 如实判为「未通过」**：三枚真实第三方插件**没有一枚走到 ctx 面**——两枚死在入口形状（`ADAPTER/ENTRY-UNKNOWN`）、一枚死在装载依赖（`ERR_MODULE_NOT_FOUND '@deepseek-ai/schemastery'`）；三枚合计暴露 **12 个在 01 稿 15 行里无归属的旧形状面**
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（§5 B3/B4/B7 已勾，B1/B2/B5/B6/B8 待切片⑥ 收口；**B5 现写明"第一批已跑 = 未通过"**）；**`docs/design/phase-2/08-real-sample-observation.md`（本轮新立：装载层门槛 + 面 census + 候选行 #16~#26 + 观察工具缺陷 D1~D5 + 方法层教训）**；`01`（只加了一条指向 08 稿的注记，**档位一条未增未改判**）；样本与证据 `tests/fixtures/cordis-plugins/real-samples/`（`SOURCES.md` + `observed/<pkg>/**`）
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 `qingbird1983`（ADR-0007）；CI 双 Node（22/26）
- 门禁现状：六道全绿（本轮**无实现代码改动**，只有文档 / 证据 / 登记）；431 测试 / 53 文件；零运行时三方依赖；最大实现文件仍 `core/src/scheduler.ts` 569 行（红线 600；`gateway.ts` 450——再加面先拆）；check-size 0 项提醒（docs 43 篇）

## 上一轮完成了什么

- **选样与取回**：按所有者三条标准（轻量 / 无复杂原生依赖 / 覆盖只读与有副作用）从 dshmarket 目录（`cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，4380 条）选出 `dsh-plugin-local-life@0.3.2`（只读算术）、`dsh-scrape-webpage@1.0.0`（抓网页 + 下载图片 + 审批升级）、`@99galaxy/dsh-turn-notify@1.0.2`（通知，主体在浏览器半）；均 MIT、均按 commit 取回（三枚哈希 = 当日 `main` 头指针，`git ls-remote` 复核过）
- **入库范围决定**：只提交 `SOURCES.md` + `observed/**`，**第三方源码树进 `.gitignore`**（`pnpm lint` 在这三枚上报 82 个 error 是实证；复现靠 commit 哈希取回）。改主意 = 撤销那三条 ignore + 给 eslint 加一条 ignore，一次决定
- **观察复跑**：每枚单独 `--out`（撞名的被迫规避），产物 = 候选 + `gaps.md` + `observe.txt`（已脱敏）+ 两趟账本；**三份 gaps/candidate md5 相同**，账本去时间戳后逐条相同
- **根因取证**：`keel observe` 三枚都报 `ACCEPT` + 退出码 0；真因靠单独起舱收 stderr 才拿到（`[cordis-cell-crash]` 全栈）
- **一手来源核对**：`@deepseek-ai/cordis@4.0.5` `src/registry.ts` 的插件三形 = `Function(ctx,config)` / `Constructor` / `Object{apply}`，**没有 `activate`**（我们认的两种形状已过时）；`@deepseek-ai/dsh-tools` 的 `DefineToolOptions` = `parameters` / `execute(args, exec)` / `output{schema,render}` / `timeoutMs?` / `isConcurrencySafe?`；`ToolRunContext` 有 `deferContext(msg)` 与 **`concludeTurn()`**（工具宣布本轮结束 = 不变量 I1/V6 正面对撞，本轮最强接管形态）
- **两个只读探针**（临时目录，未入库）：记录代理录触点；真实承接层 ctx 喂同一个 `apply` → `TypeError: ctx.provide is not a function`（未映射顶层命名空间全是 `undefined`，无改法去处），turn-notify 则**不抛错、不注册、安静返回**
- **文档**：08 稿新立 + docs/README 登记 + CHANGELOG 0.1.040 + 看板/合同 B5 注记 + 01 稿注记；沉淀 P-012 / P-013

## 下一步（按优先级，注明阻塞项）

1. **切片⑥ 设计稿**（锚 B5/B8）：先做事实核对；把 **D1~D5** 作为"观察工具正确性"子项逐条落地——D2 空候选必须非零（先写红哨兵：拿一枚已知必败的入口跑 observe，断言非 0）、D3 stderr 收进诊断并挂到 `RUN_FAILED` 摘要、D4 顶层护栏推广（`llmSurface()` 的形状）、D1 包名优先于文件名、D5 观察输入可注入外部 config。**阻塞：#16~#26 定档前，D4/#22 的改法面无法定形**
2. **等所有者两个决定**（阻塞排序）：**(a) Keel 是否供给 `@deepseek-ai/*` 宿主包（候选 #17）**——不供给则这类插件装载不了，供给 = 把他方代码放进我们的供应链（安全红线 4 的事）；**(b) 提示词贡献面 #20 与 `exec.concludeTurn()`/`deferContext` #24 走 D 档还是给声明路径**
3. **边界表第二轮**：#16~#26 定档后回填 01 稿，含 **#1 行的实现期细化**（字段名 `schema`→`parameters`、`handler`→`execute`；**缺字段必须拒，不能注册出"有名字无 schema 无处理器"的工具**——那是姿态 1 禁止的静默降级）。老规矩：只登记，不自改判
4. **真样本扩量**（n=3 不构成分布证据）：下一批专挑**真用了** `ctx.llm`/`ctx.share`/`ctx.bus`/`ctx.effects.reclaim` 的历史世代插件，且保留原始包结构（`package.json` + 外部声明层 + 多文件 `lib/`）；否则会得到"这些旧写法现实中没人用"的错误结论 → P-013
5. 开销基准复采 + `docs/design/phase-2/report.md` 阶段收口（B8）；打 `phase-2.end` 由**所有者**决定
6. 仍挂的老项：01 稿 #11 的 B/C 字面出入（待复核）；回滚是否回收共享分区里新舱的注册（动 ADR-0010）；06 稿 §9 限制 2（`paramsDigest` 实为参数全文）；standards/07 验收节补"交付物表逐条核对"；**根 `tests/` 与 `apps/*/test` 类型检查缺口**；CI `actions/checkout@v4` / `ubuntu-latest` 两处版本

> backlog（条件未触发，勿顺手做）：真样本自动取回脚本（现由 SOURCES.md 三条命令代替）、浏览器半承载（Phase 3 或永不）、`isConcurrencySafe` 进调度、服务定位 `ctx.get/provide` 的替代通道设计、流式断流的真进程时限覆盖、同步忙等的物理强杀口径、Cell 池化、容器后端、builtin 补偿动作、probe 通道、未决污染清单 CLI、跨 run 读取（Phase 3）、策略热更新（ADR-0012 重评条件 ②）。

## 未决问题

- **#16~#26 的档位**（全部待所有者定，本轮只登记倾向）；#17 是安全/供应链决定，不是兼容层决定
- 真样本源码入库与否（当前：不入库 + commit 哈希可校验取回）
- `keel observe` 的结论要不要拆成三行分别报（装载 / 观察到的面 / 候选校验），退出码取哪几问的合取
- 01 稿 #11 的档位（B 还是 C）待所有者复核
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）；Node 26 是否升 `engines` 下限

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **真样本纪律（本轮新增）**：他方源码**只读**——禁止为迁就内核改写（02 稿 §7 判据 1/2），禁止格式化（`.prettierignore` 已长期排除 `tests/fixtures/cordis-plugins/`）；入库的观察产物要抹掉本机绝对路径
- **工具自评不当证据（本轮新增）**：`keel observe` 的 `ACCEPT` 只回答"候选能否过五步校验"，**不回答"装载成功了吗 / 观察到东西了吗"**；退出码 0 与 `state=failed` 可以共存。子进程 stderr **开了管道没人读 = 静默丢弃**，三个根因会压成一个 `CELL/CRASH` → [P-012](pitfalls/P-012-观察命令的ACCEPT不等于观察到了东西.md)
- **形状类判据要取一手来源**：框架 `.d.ts` / 注册函数源码 / 发布物 `package.json`。"我记得旧框架这么写"不是依据，n=3 也不是分布证据；**合成样本只能证明"我们设想的写法可行"** → [P-013](pitfalls/P-013-用合成样本校准形状分布必然偏窄.md)
- **Phase 2 铁律**：D 档零例外；映射不到就拒绝并留痕，替代写法进手册；**合成产物不是报关单**（不自动转正）；**改法面不是旧面改名**（`guide` 塞进 `mapped` = 把 C 档谎报成 A 档）；承接层**不替旧框架发明 API**；**改边界表 = 所有者定档**，AI 只登记候选与倾向
- **`kill()` 与 `drainAndReap()` 是两件事**：drain = 拒新 + 等在途 + 宽限强杀；`kill()` = OS 级硬中断。"在途被打断"这个前提只能由 `kill()` 造 → [P-010](pitfalls/P-010-旧原语加新语义让调用点前提消失.md)
- **跨边界序列化会静默丢东西**：`JSON.stringify` 对函数/symbol/`bigint` 是丢掉不是抛；跨包错误体只按结构（`code`/`detail`）识别，`instanceof` 在包界外必然失灵 → [P-009](pitfalls/P-009-跨边界序列化会静默丢东西.md)。**这类坑只有真进程测试能看见**
- **中文标题里的 ASCII 双引号会截断字符串**，且根 `tests/` 不进类型检查 → 写完测试跑 P-011 里那条机械检查（"下次注意"已被证伪两次）→ [P-011](pitfalls/P-011-中文文案里的ASCII双引号截断字符串.md)
- **流式记账四条不变式不许松**：授权一次、预扣一次、`MODEL_INVOKED` 一条（含 `streamId`）、**每片不写事件**、终局 settle；断流按已产出部分结算 + `truncated:true`；**上游抛 ≠ 慢**（抛要报错，不把半截答案标 `done:true`）
- **归因链的表述**：依据 = `DECISION.basedOn`，信息上界 = `throughSeq` 之前的一切（含直写事件）；信封 `schemaVersion` 是按类型的表，"缺字段"不等于"内核漏写"
- **内核拥有的量不接受临场指定**：`effectId` 由 Cell 侧指派、`actionRef`/`idempotency`/`probeRef` 由报关单决定、`runId` 与授权主体由通道盖章、版本号由内核指派——插件传了就拒，不做"收到但忽略"。**注意本轮新发现的对面**：旧框架把身份与 `callId` 交给工具的 `exec` 参数，`exec.agent` 就是"按会话身份做全局操作"的入口（候选 #23）
- **真实子进程测试**：轮号不是稳定量 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)；**终态是第一条断言** → [P-008](pitfalls/P-008-屏障期死亡与空违规表.md)；**绿色要当场验真** → [P-007](pitfalls/P-007-测试绿色要当场验真.md)
- **"测试全过"不等于门禁过**：看真实退出码（`> log 2>&1; echo EXIT=$?`，不要 `| tail`）；释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)；多参构造先读签名（deps vs opts）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **跨包 import 运行期走 dist** → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)；构建只在 `tests/fixtures/global-setup.ts` 做一次；Windows 子进程 exit 滞后 stdout 关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)；CLI 收束与冷 Ledger 接笔 → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- 权限面只有一个来源：Cell 可见面一律来自 `manifestAuthRules`；`tool.invoke`/`model.invoke` 是宿主自己的执行放行，改任何一侧都要同步 `runPolicy`；**换 `agentId` = 换授权主体**，跨域用 scope（`sessionId`）
- 调度器是轮内事件唯一编排者但**非唯一写入者**；分区是 **scope 级**，跨 run 不归零；工具变更**下一轮**才进决策输入；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022
- 文档红线：ADR 只增不改（追加带日期的实施注记是允许的补正路径）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"；handoff 滚动 5 份
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-013）；方法索引：[skills/](skills/README.md)（S-001）
