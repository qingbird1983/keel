# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：**Phase 3 开工**——所有者四项决定落地：`phase-2.end` tag、cordis 测试剥离门禁、合同定稿（三件套）、切片① 评审机械化完成）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅**（tag `phase-1.end`）；**Phase 2 ✅ 提前收口**（[ADR-0014](../docs/adr/ADR-0014-drop-legacy-ecosystem-compat.md) + **`phase-2.end` tag 已打**，附言所有者定稿）；**Phase 3 🔄 进行中**（合同定稿，**切片① ✅，当前 = 切片②** 插件 A 端到端）
- **所有者四项决定（2026-11-03，ADR-0014 实施注记）**：① 首批标杆插件 = **底层测试驱动三件套**（A `echo` 只读：授权与工具发现；B `file-write` 越界写：补偿闭环；C `param-guard` 策略拦截：策略介入留痕）——原业务候选 P-A~P-D 作废；② 验收只留锚五大不变量的条目（C1/C2/C3 一票否决），业务层移 Phase 4/backlog；③ cordis 测试全部剥离主线门禁（文件留库加归档横幅，可单独复跑）；④ tag 立即打
- **门禁新现状**：`vitest.config.ts` exclude 掉 cordis 测试（**覆盖空窗风险已登记**——替补 = 三件套 C1/C3/C4）；**内核命名测试保留主线**（快照/流式/`throughSeq`/策略链，19 条）；最大实现文件 `core/src/scheduler.ts` 569 行（红线 600）
- **切片① 交付**：[02 稿](../docs/design/phase-3/02-review-mechanization.md)（18 类反面教材 → 15 条机械判据 + 3 条走别关卡的登记；三件套需求卡；REVIEW.md 留痕口径）+ `scripts/scan-native-plugins.mjs`（扫描器，CLI 可直跑）+ `tests/native-plugin-scan.test.ts`（负样本逐判据必红 + 实扫必净 + 完备性断言）+ `packages/plugins/README.md` 占位
- Phase 2 保留物不变：内核能力（`throughSeq`/快照/drain/`model.stream`/策略链/`tool.register`/装载门/`wireCell`/`keel observe`）全部生效；cordis-adapter 归档不删

## 上一轮完成了什么

- **A**：ADR-0014 追加同日实施注记（四项决定入档）；`phase-2.end` tag 打在换轨合并提交上并推送
- **B**：Phase 3 合同翻定稿（三件套、C1~C7 逐条锚 I1~I5、风险 1 = 覆盖空窗、目录定案 `packages/plugins/<name>/`）
- **C**：门禁剥离（vitest exclude + 12 个文件归档横幅）；内核保留测试单独复跑 19 条全绿
- **D**：切片① 红测先行——测试先于扫描器存在（import 缺失 = 红），实现后逐判据命中 + 实扫零命中；A3 判据按"故意过收"放宽为无词边界（驼峰也命中）
- **登记**：docs/README（合同定稿 + 02 稿新行）、看板（Phase 3 → 进行中/切片①完成、最近更新）、CHANGELOG 0.1.042；CONTEXT 重写（本卡）、H-027 归档（滚动删 H-022）

## 下一步（按优先级，注明阻塞项）

1. **切片②（插件 A `echo` 端到端）**：开工前先事实核对（manifest schema 的 `tool.provide` 声明形状、装载门就绪凭据口径、scope 绑定的装配写法），再出设计稿定稿（铁律 1），锚 C1/C5/C6
2. **切片③**：插件 B（`file-write` 补偿闭环，锚 C3）+ 插件 C（`param-guard` 策略拦截，锚 C4）
3. **切片④**：manifest 规范回填（如有缺口走 ADR）+ 阶段验收收口（`docs/design/phase-3/report.md`）→ `phase-3.end` 归所有者
4. 覆盖空窗的长线：三件套落地后核对"注册/装载门/补偿/策略链是否有等强度覆盖"，不足则补（ADR-0014 注记 3 承诺的替补义务）
5. 老项（未触发勿动）：根 `tests/` 类型检查缺口、standards/07 验收节补"交付物表逐条核对"、CI checkout 版本（下次动 CI 一并）、ADR-0010 回滚与共享分区注册（冻结）、`paramsDigest`（冻结）

> backlog（条件未触发，勿顺手做）：流式插件与记账场景延后启用（合同 §2 明载）、观测生态与跨 run 读取、`keel observe` 改造为原生脚手架（切片②起按需）、Cell 池化、容器后端、策略热更新（ADR-0012 重评条件 ②）、Phase 4 业务层插件（多 Agent 编排、UI）。

## 未决问题

- 无阻塞未决——Phase 3 合同已定稿，三处前置全部关闭
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）；Node 26 是否升 `engines` 下限（先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 3 铁律**：新插件先过 [反面教材清单](../docs/design/phase-3/01-legacy-anti-patterns.md)（机器层 = 禁面扫描零命中 + 人工层 = REVIEW.md 逐条留痕）；manifest 缺口 → 设计稿 → ADR → 才实现，**不临场发明 API**；扫描器**故意过收，无豁免通道**，误报改插件写法绕开歧义
- **禁面符号表改动规矩**：新行入 01 清单时同步扩 `FORBIDDEN_SURFACES` + `REQUIRED_ROWS` + 补负样本（缺一即完备性断言红）
- **"旧生态的能做到"是拒绝理由不是待办**——引 ADR-0014；**归档 ≠ 可删**：cordis 测试虽出主线，断言仍留库可单独复跑
- **门禁剥离的覆盖空窗是已接受的登记风险**（ADR-0014 注记 3），别把"cordis 测试不在 CI"误读为"可以删"
- **扫描器自证的教训已内建**：负样本组证明扫描器有效、实扫组证明在库干净、完备性断言防漏报 → [P-012](pitfalls/P-012-观察命令的ACCEPT不等于观察到了东西.md)
- **真样本纪律仍有效**（他方源码只读、观察产物抹绝对路径）——Phase 3 再取外部参考同规矩
- **`kill()` 与 `drainAndReap()` 是两件事**；"在途被打断"只能由 `kill()` 造 → [P-010](pitfalls/P-010-旧原语加新语义让调用点前提消失.md)
- **跨边界序列化会静默丢东西**：`JSON.stringify` 丢函数/symbol/`bigint` 不抛；跨包错误体按结构识别（`code`/`detail`）→ [P-009](pitfalls/P-009-跨边界序列化会静默丢东西.md)。**这类坑只有真进程测试能看见**
- **中文文案里的 ASCII 双引号截断字符串**，根 `tests/` 不进类型检查 → 写完跑 P-011 机械检查 → [P-011](pitfalls/P-011-中文文案里的ASCII双引号截断字符串.md)
- **流式记账四条不变式不许松**（延后启用的场景同理）：授权一次/预扣一次/`MODEL_INVOKED` 一条（含 `streamId`）/每片不写事件/终局 settle；断流按已产出结算 + `truncated:true`；**上游抛 ≠ 慢**
- **归因链表述**：依据 = `DECISION.basedOn`（关键引用），上界 = `throughSeq` 之前一切；信封 `schemaVersion` 按类型，"缺字段"≠"内核漏写"
- **内核拥有的量不接受临场指定**：`effectId`/`actionRef`/`idempotency`/`probeRef`/`runId`/授权主体/工具版本号各有归属——插件传了就拒；旧框架 `exec.agent` 是"按会话身份做全局操作"的入口（反面教材 B2）
- **真实子进程测试**：轮号不是稳定量 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)；**终态是第一条断言** → [P-008](pitfalls/P-008-屏障期死亡与空违规表.md)；**绿色要当场验真** → [P-007](pitfalls/P-007-测试绿色要当场验真.md)
- **"测试全过"不等于门禁过**：看真实退出码（`> log 2>&1; echo EXIT=$?`，不要 `| tail`）；释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)；多参构造先读签名（deps vs opts）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **跨包 import 运行期走 dist** → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)；构建只在 `tests/fixtures/global-setup.ts` 一次；Windows 子进程 exit 滞后 stdout 关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)；CLI 收束与冷 Ledger 接笔 → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- 权限面只有一个来源：Cell 可见面一律来自 `manifestAuthRules`；`tool.invoke`/`model.invoke` 是宿主执行放行，改任何一侧同步 `runPolicy`；**换 `agentId` = 换授权主体**，跨域用 scope（`sessionId`）
- 调度器是轮内事件唯一编排者但**非唯一写入者**；分区是 **scope 级**跨 run 不归零；工具变更**下一轮**才进决策输入；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022
- 文档红线：ADR 只增不改（追加带日期的实施注记是允许的补正路径）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"；handoff 滚动 5 份
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-013）；方法索引：[skills/](skills/README.md)（S-001）
