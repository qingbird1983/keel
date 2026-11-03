# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：**Phase 3 切片②完成**——首个原生插件 `echo` 端到端 + 内核静态工具发布缺口处置 + 集成面收口）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅**（tag `phase-1.end`）；**Phase 2 ✅ 提前收口**（[ADR-0014](../docs/adr/ADR-0014-drop-legacy-ecosystem-compat.md) + `phase-2.end` tag）；**Phase 3 🔄 进行中（合同定稿）：切片① ✅、切片② ✅，当前 = 切片③**（插件 B 补偿闭环 + 插件 C 策略拦截，锚 C3【一票否决】/C4）
- **切片② 交付**：[03 稿](../docs/design/phase-3/03-plugin-a-echo.md)（两道闸定稿：事实核对 F1~F5 + 决策 D1~D5 + E1~E6 验收剧本）；`packages/plugins/echo/`（真报关单 + 零 import src + 包内单测 + [REVIEW.md](../packages/plugins/echo/REVIEW.md) 转正留痕）；`tests/native-echo-e2e.test.ts`（E1~E6 真进程 5 用例）；内核缺口 **F4 处置**（见下）；workspace 增一行 `packages/plugins/*`
- **F4（已修）**：默认入口 `main.ts` 原先只本地登记静态工具、不发布 → 决策输入全盲（ADR-0011 声称关掉的"首轮空表"对原生插件还开着）。现装载义务 = 本地登记 **和** 经既有 op `tool.register` 的跨进程发布，完成才 `markReady()`；发布失败 = 进程 crash（可见失败）；ADR-0011 带日期实施注记（D2 定案：不新增 ADR）
- **集成面（03 稿 §4.5）**：凡装配默认入口舱的宿主必须把报关单编译进策略（`manifestAuthRules` / apps/keel `runPolicy(For)`）+ spawn 后任何 await 前挂好 serve+alloc。CLI 五处（scenario a2/a3/a4、hotswap、recover、bench B3 改走 wireCell）与 8 个 rig 已收口；3 个 rig 潜伏接线缺陷（漏传 deps / 残缺 deps / serve 前被 await 隔开）被本改动暴露并修复（P-002 复发记录）
- **门禁现状**：六道门禁全绿（43 文件 **344 测试**）；扫描器实扫 echo 实体零命中（C2 持续证据）；最大实现文件 `core/src/scheduler.ts` 569 行（红线 600）
- Phase 2 保留物不变：内核能力全部生效；cordis-adapter 归档不删、其测试留库可单独复跑

## 上一轮完成了什么

- **A**：03 稿两道闸（提纲+五决策点确认 → 全文定稿）；事实核对 F1~F5（F4 = 缺口发现，合同风险 2 的首次实战产出）
- **B**：红测先行——e2e 先于内核补丁存在（补丁前 E1 发现面红 `[[],[],[]]` + E4 红；补丁后 5/5 绿）
- **C**：内核补丁（D1 方案 1）+ ADR-0011 注记；echo 包落地；扫描器载体排除 test/（[02 稿 §7](../docs/design/phase-3/02-review-mechanization.md) 带日期注记——**非符号豁免**）
- **D**：CLI 与 rig 集成面收口（见上）；A1 boot 加"等静态发布落分区"栅栏、期望按新 boot 状态重算；CHANGELOG 0.1.043、看板、CONTEXT 重写（本卡）、H-028 归档（滚动删 H-023）、P-002 复发记录

## 下一步（按优先级，注明阻塞项）

1. **切片③（插件 B + C）**：开工前设计稿两道闸（铁律 1）。B `file-write`：补偿模板声明（`fs.write` + `paths.allow`…词表口径先核对 manifest 稿 §5.2——`paths.allow` 尚无此字段形状，**预期走 ADR 或设计稿修订**，勿临场发明）+ EFFECT_DECLARED/补偿闭环真进程证据（锚 C3【一票否决】）；C `param-guard`：policy manifest + hook 白名单 + 策略舱崩溃 fallback（锚 C4，B7① 口径延续）
2. **切片④**：manifest 规范回填（B 的路径清单诉求大概率触发修订）+ 阶段验收 C1~C7 复核 + `docs/design/phase-3/report.md` + 基准复采（D4 定案：三件套齐后统一采插件自身开销，只测量不设阈值）→ `phase-3.end` 归所有者
3. 覆盖空窗核对（合同风险 1）：三件套齐后核对注册/装载门/补偿/策略链是否有等强度覆盖
4. 老项（未触发勿动）：根 `tests/` 类型检查缺口（本轮三个 rig 潜伏缺陷全靠它掩盖——价值再证）、standards/07 验收节补"交付物表逐条核对"、CI checkout 版本（下次动 CI 一并）、ADR-0010 回滚与共享分区注册（冻结）、`paramsDigest`（冻结）

> backlog（条件未触发，勿顺手做）：流式插件与记账场景延后启用（合同 §2）、观测生态与跨 run 读取、`keel observe` 改造为原生脚手架（切片③起按需）、Cell 池化、容器后端、策略热更新（ADR-0012 重评条件 ②）、Phase 4 业务层插件。

## 未决问题

- 无阻塞未决；切片③的 B 路径清单字段形状待设计稿核对后定（缺口 → 登记设计稿 → ADR → 才实现）
- 仓库是否转公开（所有者择时；MIT + 署名已就绪）；Node 26 是否升 `engines` 下限（先观察）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 3 铁律**：新插件先过 [反面教材清单](../docs/design/phase-3/01-legacy-anti-patterns.md)（机器层扫描零命中 + 人工层 REVIEW.md 逐条留痕）；manifest 缺口 → 设计稿 → ADR → 才实现，**不临场发明 API**；扫描器故意过收、无豁免通道，误报改写法绕开歧义；**REVIEW.md 引反面教材用行号不抄判据串**（C4 判据扫 md）
- **宿主装配默认入口舱的两条硬规矩（03 稿 §4.5）**：① 报关单编译进策略（未编译 = 发布被拒 = 舱装载即死——这是设计不是 bug）；② `spawnCell` 之后、**任何 await 之前**挂好 serve + alloc（装载期必有跨进程往返）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md) 复发记录
- **装载期拒绝的负路径已通**：manifest `allow` 收窄 vs 代码清单不一致 → 发布被拒 → 舱 crash → `wireCell` 可见失败（E4；manifest 稿 §5.2 "可选收窄"的首个真进程证据）
- **"旧生态的能做到"是拒绝理由不是待办**——引 ADR-0014；**归档 ≠ 可删**：cordis 测试断言留库可单独复跑；覆盖空窗是已登记风险（ADR-0014 注记 3），替补 = 三件套 C1/C3/C4
- **真样本纪律**（他方源码只读、观察产物抹绝对路径）；**红测先行**（先复现后修复）；**绿色要当场验真**（P-007；本轮三个 rig"绿"是运气绿的前科）
- **`kill()` 与 `drainAndReap()` 是两件事**；"在途被打断"只能由 `kill()` 造 → [P-010](pitfalls/P-010-旧原语加新语义让调用点前提消失.md)；真实子进程时序用显式栅栏不用 sleep → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)
- **跨边界序列化会静默丢东西** → [P-009](pitfalls/P-009-跨边界序列化会静默丢东西.md)；中文文案 ASCII 双引号 → 写完跑 [P-011](pitfalls/P-011-中文文案里的ASCII双引号截断字符串.md) 机械检查
- **流式记账四条不变式不许松**（延后启用同理）；**归因链表述**：依据 = `DECISION.basedOn`，上界 = `throughSeq` 之前一切
- **内核拥有的量不接受临场指定**（effectId/actionRef/runId/授权主体/工具版本号各有归属）；权限面唯一来源 = `manifestAuthRules`；换 `agentId` = 换授权主体，跨域用 scope（`sessionId`）
- 调度器是轮内事件唯一编排者但非唯一写入者；分区 scope 级跨 run 不归零；工具变更下一轮才进决策输入；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022
- 文档红线：ADR 只增不改（带日期实施注记是允许的补正路径）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"；handoff 滚动 5 份
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-013）；方法索引：[skills/](skills/README.md)（S-001）
