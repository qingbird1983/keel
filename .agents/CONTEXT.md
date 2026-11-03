# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：Phase 2 切片④施工 + 收口——策略插件 → 插话总线的装配链接通，B4【一票否决】与 B7① 达成）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end`）；**Phase 2 🔄 进行中**（tag `phase-2.start`）
- **切片① ✅**：运行期注册两 op + 承接层骨架 + A 档合成组；B1 三主张真实多进程通过
- **切片② ✅**：装载门（ADR-0011）+ `wireCell()` 收敛点 + 两遍观察合成 + `keel observe`；B2、B6 通过
- **切片③ ✅**：三个改法面 `ctx.model.invoke` / `ctx.effects.declare` / `ctx.ledger.read` + `guide` 第四桶 + 旧插件补偿表/快照面 + 迁移手册首版；**B3 通过**
- **切片④ ✅（本轮）**：策略舱独立进程（`policy-main` + 新 op `policy.hook`，ADR-0012）+ `wirePolicies` 接线（抢注整份拒、注册是最后一步、退出不级联）+ `keel run --policy-*` + `ASSEMBLY_RECORDED.policies`；**B4【一票否决】达成**、**B7① 达成**
- **当前 = 切片⑤设计稿**（锚 **B7②③④⑤ + B8**：`DECISION.throughSeq`、快照物理持久化、旧 Cell drain 完整语义、`model.stream`）——铁律 1：稿未定稿前不写实现代码
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（§7 六片、§5 B1~B8）；边界 `01-cordis-migration-boundary.md`（B 档只剩 #5/#11，#11 有一处待复核的字面出入）；`02`/`03`/`04`（§11 施工期偏差）/`05-migration-handbook.md`（手册，§8 已给 D 档可抄路径）/`06`（§9 六条限制 + §10 八条施工记录）；`ADR-0010`/`0011`/`0012`（含四条实施注记）
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 `qingbird1983`（ADR-0007）；CI 双 Node（22/26）；**main = `2089a49`**（切片④定稿合并点；本轮施工在其后）
- 门禁现状：六道全绿（`pnpm clean` 起）；**388 测试 / 48 文件**；零运行时三方依赖；最大实现文件 `core/src/scheduler.ts` 569 行（红线 600）；测试夹具 `tests/fixtures/cordis-rig.ts` 已从 631 拆到 552（声明侧进 `cordis-manifests.ts`）；check-size 0 项提醒（docs 40 篇）

## 上一轮完成了什么

- **策略舱进程体**：`packages/cell-runtime/src/policy-main.ts`（只认 `export const hooks`，不注入 `CellClient`）+ `policy-hooks.ts`（装载期核对"导出集合 = 报关声明集合"，少 = 两张皮、多 = 未申领插话）+ `cell.ts` 的 `policy.hook` 路由（载荷 `{hook, input}`，不设舱内时限）
- **宿主接线**：`packages/host/src/policy-link.ts` = 预检（kind / 白名单 / 抢注整份拒，全在起舱之前）→ 起舱并探就绪（复用 `cell.snapshot` 一次应答）→ **最后一步整批注册**；失败整批 drain 后原样重抛，总线一条 handler 都不挂
- **时限只有一个来源**：`HOOK_TIMEOUT_MS` 从 `@keel/core` 导出，宿主→策略舱的请求超时直接用它；失败一律既有 fallback（`HOOK_VERDICT{fallback:true}`），**零新错误码**
- **交付入口**：`keel run --policy-manifest <path> --policy-module <path>`（成对可重复，`parseList`），`runtime.ts` 在装配期接 `wirePolicies` 并把 `policies` 送进装配审计；`closeRuntime` 收策略舱
- **四 hook 的真进程证据**（B7①，9 条）：deny 真的挡住且被挡的那次连 handler 都没进（文件外记号核对）；stopAdvice 收束但终态由内核写；retryAdvice 要 1 小时退避也被钳成 `30_000×3`、4 次调用封顶；budgetExhaustedChoice 选 graceful → `RUN_HALTED`，同样额度没绑策略 → `RUN_FAILED`；策略舱半途死掉 → 后续插话 fallback、run 照常收束、能力舱无恙
- **D 档拒绝（B4，13 条）**：七枚尝试全复演（四枚真进程 + 三枚装配期整份拒）+ 机械核对 (a) 事件计数、(b) 注入面源码扫描（四个注入面文件零控制面把手，`policy-main` 依赖闭包不含内核包）、(c) 负例组 8 枚全拒零产物
- **样本与夹具**：策略模块 7 枚进 `tests/fixtures/policies/`；旧形状尝试 3 枚 + B7 工具集 1 枚；畸形 manifest 2 枚进 `fixtures/manifest-negative/`（6→8，README + 防漂移清单同步）；rig 新增 `policies` / `budgetLimits` / `RoundPlan.model|before|label` / `retryDelays`
- **文档**：ADR-0012 追加四条实施注记（不改决策）；06 稿 §8 打勾 + §10 八条施工记录；01 稿 #7/#14 注记（档位未动）；05 手册 §8 可抄路径 + 证据表；契约 §4.8 载荷描述与实现对齐；Phase 1 报告限制条目与回填清单标注已兑现；CHANGELOG 0.1.036 / 看板 / H-023 / P-002·P-007 更新

## 下一步（按优先级，注明阻塞项）

1. **切片⑤设计稿**：`DECISION.throughSeq`（ADR-0008 已立，需契约 §4.1/§5 修订注记 + Phase 1 旧账本兼容样例）、快照物理持久化、旧 Cell drain 完整语义、`model.stream`（锚 B7②③④⑤，并带 B8 的延迟基准观察）；开工先做事实核对
2. **待所有者处置**：01 稿 #11 的 B/C 字面出入（`ledger.read` 不需声明、manifest 无对应字段，而插件方确实要改一行代码）——只登记，不自改判
3. 未决的老边界：**回滚是否回收共享分区里新舱的注册**（动 ADR-0010 版本唯一事实源，需评审）；06 稿 §9 限制 2（`paramsDigest` 实为参数全文，策略因此看得见参数）——改字段语义还是另立回填项，切片⑤一并呈报
4. 真样本到位后 B1/B5 第二批复跑 + 符号回填（阻塞"真实插件可迁移"表述，不阻塞施工）；策略热更新若要复用切片② 升级接缝 = ADR-0012 重评条件 ②
5. 规范修订两处仍待办（Phase 1 报告 §8）：standards/07 验收节补"交付物表逐条核对"强制项；根 `tests/` 与 `apps/*/test` 的类型检查缺口（现由 P-007 的顺序纪律替代，P-002 复发记录又添一例实证）
6. 工具链小项（非阻塞）：CI `actions/checkout@v4` 仍以 Node 20 为目标、`ubuntu-latest` 已迁 Ubuntu 26——下次动 CI 一并升版本并固定 runner 标签

> backlog（条件未触发，勿顺手做）：观察运行的人工参数注入、probe 通道、builtin 补偿动作、退避参数可配置面、未决污染清单 CLI、Cell 池化、容器后端、分布式、观测生态与跨 run 读取（Phase 3）、activation 期调用新面的真实形态（等真样本暴露）、策略进程忙等的物理强杀口径（与容器后端一起评）。

## 未决问题

- 01 稿 #11 的档位（B 还是 C）待所有者复核
- "回滚是否应回收共享分区里新舱的注册"——需要版本回退语义，动 ADR-0010，待切片⑤评审
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- Node 26 是否升为 `engines` 下限（当前 `>=22`；CI 矩阵已双覆盖，先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 2 铁律**：D 档零例外；映射不到就拒绝并留痕，替代写法进迁移手册。**合成产物不是报关单**——不给自动转正；**改法面不是旧面改名**——把 `guide` 塞进 `mapped` 就是把 C 档谎报成 A 档（B5 一票否决的漂移形态）
- **策略插件的三条硬边界**（ADR-0012）：只在自己的进程里、只有 `policy.hook` 一条被动通道、裁决校验永远在内核 HookBus。想加"策略也能主动做点什么"= 先改 ADR；两份策略抢同一插话点 = 装配期整份拒，**不开"同名覆盖"的口子**（覆盖 = 静默改判）
- **归因链的两个位置**：轮号在账本（`HOOK_CALLED{hook, round}`）而不在帧里；"绑了哪些策略"在 `ASSEMBLY_RECORDED.policies`，"谁说了话"在 `DECISION.basedOn`。评审问"这一轮究竟是谁的话"，答案只能从账本出
- **内核拥有的量不接受临场指定**：`effectId` 由 Cell 侧指派、`actionRef`/`idempotency`/`probeRef` 由报关单决定、`runId` 由通道盖章、版本号由内核指派——插件传了就拒，**不做"收到但忽略"**
- **真实子进程测试**：轮号不是稳定量（装载屏障会吃掉空转轮）——归因断言写成"存在更晚的 `DECISION.basedOn`"，策略条件写成"摘要里的标记"；先写时序假设 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)；**终态是第一条断言**，屏障期死亡的 run 必须留下违规 → [P-008](pitfalls/P-008-屏障期死亡与空违规表.md)；**绿色要当场取证** → [P-007](pitfalls/P-007-测试绿色要当场验真.md)
- **多参构造先读签名**：deps 与 opts 是两个参数位，塞错位置不报错、静默失效——本轮栽在测试夹具的 `new Scheduler(deps, opts)` 上 → [P-002](pitfalls/P-002-集成测试装配接线四类错.md) 复发记录；每个"应该到达的选项"留一条可断言的缝
- **"测试全过"不等于门禁过**：看真实退出码（`> log 2>&1; echo EXIT=$?`，不要 `| tail`）；释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)
- **跨包 import 运行期走 dist**：改 `packages/*/src` 不 rebuild 就跑 `tests/` 会 `x is not a function` → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)；**构建只在 `tests/fixtures/global-setup.ts` 做一次** → [P-002 规则 5](pitfalls/P-002-集成测试装配接线四类错.md)
- **CLI 资源收束 + 冷 Ledger 接笔** → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)；**Windows 子进程 exit 滞后 stdout 关闭** → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **证据表述纪律**：合成组结果不得表述为"真实存量插件已验证"；舱内原生 `fetch`/`fs` 与模型 SDK 直调**观察不到**（02 稿 F4），只能写缺项；`toolCallTimeoutMs` 拦不住同步忙等；施工顺序若偏离清单，**在 §8 明写"本轮没有红测保护"**，不追认成"先红后绿" → [P-007](pitfalls/P-007-测试绿色要当场验真.md)
- 权限面只有一个来源：Cell 可见面一律来自 `manifestAuthRules`；`tool.invoke`/`model.invoke` 是宿主自己的执行放行，改任何一侧都要同步 `runPolicy`；**换 `agentId` = 换授权主体**，跨域用 scope（`sessionId`）
- 调度器是轮内事件唯一编排者但**非唯一写入者**；分区是 **scope 级**，跨 run 不归零；工具变更**下一轮**才进决策输入；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022
- 文档红线：ADR 只增不改（追加带日期的实施注记是允许的补正路径）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"；handoff 滚动 5 份
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-008）；方法索引：[skills/](skills/README.md)（S-001）
