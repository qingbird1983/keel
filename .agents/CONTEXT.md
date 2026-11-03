# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：**战略转向登记与换轨**——ADR-0014 放弃全面兼容 DSH 旧生态，Phase 2 提前收口，Phase 3 合同草案就绪）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end`）；**Phase 2 ✅ 提前收口**（2026-11-03，[ADR-0014](../docs/adr/ADR-0014-drop-legacy-ecosystem-compat.md)；逐项处置表在 phase-2 合同 §8；tag `phase-2.end` 是否打**归所有者**）；**Phase 3 🔄 启动准备**（合同草稿 `docs/roadmap/phase-3-native-ecosystem.md`）
- **转向决定（所有者原话理由）**：① DSH 插件形态还在变，跟做适配没有尽头；② Keel 定位是"少而精"的需求驱动定制底座，不是旧插件收容所；③ 真样本暴露的野路子（改提示词、要提权、依赖外部包）违背核心不变量
- **ADR-0014 五条决定**：停止全面兼容；边界表冻结（候选行 #16~#26 不回填）；B5 作废（08 稿第一批已判未通过，作废 ≠ 未做过）；Phase 2 提前收口；adapter 归档不删 + 进入 Phase 3 原生生态
- **Phase 2 保留物**（合同 §8）：B1/B2/B3/B4/B6/B7 达成的证据留在测试里；内核能力（`throughSeq` 归因上界 / 快照落盘 / drain 次序 / `model.stream` 记账 / 策略链 / `tool.register` / 装载门 / `wireCell` / `keel observe`）全部继续生效，由原生插件直接使用；`packages/cordis-adapter` 归档（README 横幅 + package.json `[ARCHIVED]`），**其测试是内核通道 op 唯一真进程证据链，门禁归属待所有者定**
- **Phase 3 已就绪的材料**：反面教材否决清单 `docs/design/phase-3/01-legacy-anti-patterns.md`（18 类否决面 + 五步评审流程）；合同草案（做/不做、开工前置、C1~C8 验收场景草案、首批候选 P-A~P-D、切片①~④ 草案）
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 `qingbird1983`（ADR-0007）；CI 双 Node（22/26）
- 门禁现状：六道全绿（本轮**无实现代码改动**，只有文档 / 登记 / 包元数据）；431 测试 / 53 文件；零运行时三方依赖；最大实现文件仍 `core/src/scheduler.ts` 569 行（红线 600；`gateway.ts` 450、`runtime.ts` 456——再往网关加面先拆）

## 上一轮完成了什么

- **登记**：ADR-0014（含三个被否备选：继续全量兼容 / 物理删除包 / 只改文档不标包）；phase-2 合同头部翻"提前收口" + **§8 终止处置表**（B1/B2/B3/B4/B6/B7 达成、B5 作废、B8 部分、切片⑥ 终止、结尾"保留物"段）；01 稿冻结注记；08 稿 §8 superseded 补记
- **换轨**：00-roadmap 全面更新（最近更新、mermaid、P2/P3 两行、风险簿"兼容有损"行 → 已处置）；architecture/01 §7 重写（历史迁移路径留痕）+ §10 风险行；standards/01 包清单注记；docs/README 新增三行（ADR-0014 / phase-3/01 / phase-3 合同）+ phase-2 合同状态翻面；CHANGELOG 0.1.041
- **产出**：反面教材否决清单（18 类：控制权 A1~A4 / 权限 B1~B5 / 状态 C1~C4 / 形态 D1~D5，每类含真实出处 + 违反不变量 + 评审问句 + 正解；五步评审流程）；Phase 3 合同草案（三处待所有者定稿）
- **adapter 归档标记**：包 README 重写（归档横幅 + 不删理由 = 证据链）+ package.json `description`/`keywords` 标 `[ARCHIVED 2026-11-03 per ADR-0014]`
- **收尾**：CONTEXT 重写（本卡）、H-026 归档（滚动删 H-021）、P-013 补 2026-11-03 更新（"真样本扩量"作废，教训转塑 Phase 3 需求卡制度 + 否决清单）

## 下一步（按优先级，注明阻塞项）

1. **等所有者三个决定**（Phase 3 开工前置，阻塞切片①）：① 首批标杆插件从候选 P-A~P-D 选 2~3（P-A 会话日志整理器 / P-B 文档体检器 / P-C 文件归档器 / P-D 发布流水线，覆盖"只读/有副作用/用模型"象限）；② C1~C8 验收场景取舍；③ cordis 测试的门禁归属（建议：保留至原生插件对通道 op 形成等强度覆盖再移出）
2. **Phase 3 切片①**（决定后开工）：合同定稿 + 评审流程机械化（符号扫描扩展到"原生插件不允许的面"、逐条留痕脚本）+ 首插件需求卡；设计稿定稿前不写实现（铁律 1）
3. `phase-2.end` tag：所有者择时（ADR-0014 明确归所有者）
4. 归档包处置长线：原生插件测试对通道 op 形成等强度覆盖后，cordis 测试移出门禁；届时再评物理删除（先进 backlog）
5. 老边界（未触发勿动）：ADR-0010 回滚与共享分区注册、01 稿 #11 字面出入、`paramsDigest`（06 稿 §9 限制 2）——**三者随边界表冻结一并冻结**；仍有效：根 `tests/` 类型检查缺口（Phase 1 报告 §8 待办）、standards/07 验收节补"交付物表逐条核对"、CI checkout 版本升级（下次动 CI 一并）
6. backlog 新增候选：`keel observe` 改造为原生插件脚手架的口径（Phase 3 切片①定）；归档包物理删除（等强度覆盖后）

> backlog（条件未触发，勿顺手做）：流式计时断流真进程覆盖、同步忙等的物理强杀口径、Cell 池化、容器后端、builtin 补偿动作、probe 通道、未决污染清单 CLI、观测生态与跨 run 读取（有真实需求再立项）、策略热更新（ADR-0012 重评条件 ②）。

## 未决问题

- Phase 3 三处待定稿（见"下一步"1）——所有者决定
- `phase-2.end` 是否打 tag——所有者择时
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- Node 26 是否升 `engines` 下限（当前 `>=22`；CI 双覆盖，先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 3 铁律**：评审任何新插件（含自写标杆）先过 [反面教材清单](../docs/design/phase-3/01-legacy-anti-patterns.md)，命中即退回，**不提供"以后再兼容"通道**；manifest 缺口 → 登记设计稿 → ADR → 才实现，**不临场发明 API**；每插件一页需求卡（防"为了凑数而写"，恰是 P-013 的教训）
- **"旧生态的能做到"从此是拒绝理由，不是兼容待办**——有人拿"旧插件就是这么写的"当理由时，引 ADR-0014
- **归档 ≠ 可删**：cordis-adapter 测试是内核通道 op（注册/装载门/policy.hook/流式/快照/drain）唯一真进程证据链，移出门禁前先有等强度覆盖
- **观察/诊断命令的自我宣判要拆问**：`ACCEPT` ≠ 观察到了东西；stderr 有管道无读者 = 静默丢弃 → [P-012](pitfalls/P-012-观察命令的ACCEPT不等于观察到了东西.md)
- **合成样本校准不了形状分布**：判据取一手来源（框架 `.d.ts` / 发布物 `package.json`）；需求要真（需求卡）→ [P-013](pitfalls/P-013-用合成样本校准形状分布必然偏窄.md)
- **真样本纪律仍有效**（他方源码只读、观察产物抹绝对路径）——Phase 3 若再取外部参考，同规矩
- **`kill()` 与 `drainAndReap()` 是两件事**：drain = 拒新 + 等在途 + 宽限强杀；`kill()` = OS 级硬中断。"在途被打断"这个前提只能由 `kill()` 造 → [P-010](pitfalls/P-010-旧原语加新语义让调用点前提消失.md)
- **跨边界序列化会静默丢东西**：`JSON.stringify` 丢函数/symbol/`bigint` 不抛；跨包错误体只按结构（`code`/`detail`）识别，`instanceof` 在包界外必然失灵 → [P-009](pitfalls/P-009-跨边界序列化会静默丢东西.md)。**这类坑只有真进程测试能看见**
- **中文文案里的 ASCII 双引号会截断字符串**，且根 `tests/` 不进类型检查 → 写完跑 P-011 机械检查 → [P-011](pitfalls/P-011-中文文案里的ASCII双引号截断字符串.md)
- **流式记账四条不变式不许松**：授权一次 / 预扣一次 / `MODEL_INVOKED` 一条（含 `streamId`）/ 每片不写事件 / 终局 settle；断流按已产出结算 + `truncated:true`；**上游抛 ≠ 慢**
- **归因链表述**：依据 = `DECISION.basedOn`（关键引用），信息上界 = `throughSeq` 之前一切；信封 `schemaVersion` 按类型，"缺字段"不等于"内核漏写"
- **内核拥有的量不接受临场指定**：`effectId` Cell 侧指派、`actionRef`/`idempotency`/`probeRef` 报关单决定、`runId`/授权主体通道盖章、版本号内核指派——插件传了就拒；旧框架 `exec.agent` 是"按会话身份做全局操作"的入口（反面教材 B2）
- **真实子进程测试**：轮号不是稳定量 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)；**终态是第一条断言** → [P-008](pitfalls/P-008-屏障期死亡与空违规表.md)；**绿色要当场验真** → [P-007](pitfalls/P-007-测试绿色要当场验真.md)
- **"测试全过"不等于门禁过**：看真实退出码（`> log 2>&1; echo EXIT=$?`，不要 `| tail`）；释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)；多参构造先读签名（deps vs opts）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **跨包 import 运行期走 dist** → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)；构建只在 `tests/fixtures/global-setup.ts` 做一次；Windows 子进程 exit 滞后 stdout 关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)；CLI 收束与冷 Ledger 接笔 → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- 权限面只有一个来源：Cell 可见面一律来自 `manifestAuthRules`；`tool.invoke`/`model.invoke` 是宿主执行放行，改任何一侧同步 `runPolicy`；**换 `agentId` = 换授权主体**，跨域用 scope（`sessionId`）
- 调度器是轮内事件唯一编排者但**非唯一写入者**；分区是 **scope 级**跨 run 不归零；工具变更**下一轮**才进决策输入；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022
- 文档红线：ADR 只增不改（追加带日期的实施注记是允许的补正路径）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"；handoff 滚动 5 份
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-013）；方法索引：[skills/](skills/README.md)（S-001）
