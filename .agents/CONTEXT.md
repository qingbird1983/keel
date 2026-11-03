# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**切片④ 插件 B/C 转正，三件套闭环**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅ 提前收口（[ADR-0014](../docs/adr/ADR-0014-drop-legacy-ecosystem-compat.md)）/ Phase 3 🔄：切片① ② ③ ③.5 **④ ✅（本轮完成）**
- 下一片 = **切片⑤**：manifest 规范回填复核（governance/trust/R3 注记）+ 阶段验收 C1~C7 复核（C2/C3/C4 已达成打勾，C5/C6/C7 待复核）+ Phase 3 报告收口 + 基准复采
- 本轮交付：[08 稿](../docs/design/phase-3/08-plugin-b-c.md) 定稿（K1~K5 所有者确认）+ 插件 B/C 转正 + `REVIEW.md` ×2；验收证据 [合同 §5](../docs/roadmap/phase-3-native-ecosystem.md) C2/C3/C4 注记
- 六道门禁全绿：format / lint / typecheck / build / test（**56 文件 420 测试**）/ check-size（docs 59/150）；禁面扫描三件零命中
- 切片④提交在分支 `feat/phase3-slice4-plugin-b-c`（未 merge）；R1~R5 欠账已还（三 commit + merge `0eb7c39`）

## 本轮实现了什么

- **插件 B `file-write` 转正**（`packages/plugins/file-write/`）：纯 handler 一行业务（`ctx.workspace.create`）；manifest = `fs.write` allow + `governance`（guard from path + effect `fs.write.done`）+ builtin `fs.remove` 模板。e2e B-E1~E5（`tests/native-file-write-e2e.test.ts`）：补偿闭环（注入故障 → 只删本次创建 → 账本全链）、越界拒零部分生效、重试幂等、补偿只读账本可重放、预存在目标 `WORKSPACE/EXISTS` + 0 误删。红测先行（转正件缺席 = 红）。
- **插件 C `param-guard` 转正**（`packages/plugins/param-guard/`）：`export const hooks = { toolApproval }`；规则 = 拒 content 含 `TOPSECRET`（guard 结构上看不到的内容面）。e2e C-E1~E4（`tests/native-param-guard-e2e.test.ts`，联装 B 工具舱 + `wirePolicies`）：deny 可归因（介入 seq 进 `DECISION.basedOn`）、放行不误伤、杀策略舱 → `HOOK_VERDICT{fallback:true}` 不级联、未申领 hook 零介入。红测先行。
- **顺手修正**：vitest include 缺 `packages/plugins/*/test/` 一层——echo 包内单测此前从未被主线收集；已修（提取 [P-016](pitfalls/P-016-测试收集范围少一层glob等于测试静默不跑.md)）。
- **留痕**：`REVIEW.md` ×2（02 稿 §5 五段：manifest 摘录 / 18 行逐条 / 看代码三件事 / 门禁证据 / D5）；扫描 clean。

## 关键决策口径（别改错）

- **三件套分工**（K1/K4）：转正 B 只有 `write_file`（纯新建语义，已存在 → `WORKSPACE/EXISTS`）；fixture 保留为机制样例（overwrite/多 effect/env_probe 的机制证据在 R1~R5 测试）。
- **策略规则在代码**：policy 报关单 schema 强制 permissions/resources/compensation/governance/trust 全空——"拟拦截的能力名"无声明位（08 稿 F2）；不做规则语言。
- **`paramsDigest` 字段名承载明文 params**（toolApproval 通道，契约既有形状，不改名）；verdict 值域 = `approve/deny`（08 稿草案曾误写 allow，已修）。
- **`policies` 装配摘要由调用方合入** `scheduler.start` 的 assembly（`{...manifest.record, policies: bindings.map(b=>b.summary)}`，没绑不写字段）——`wirePolicies` 不改 manifest。
- **红态演示方法**：vitest globalSetup 会重建 dist,"删 dist 跑红"不可行;红态 = stash 转正件（e2e 引用缺席 = 红）→ pop → 绿。
- 沿用口径：AOP 不是沙箱;声明 ≠ 事实（收据才是）;写文件唯一黄路径 = `ctx.workspace`;幂等 = 同 `toolCallId` 复用收据。

## 已验证 / 未验证

- 已验证：B-E1~E5 / C-E1~E4 真进程；56 文件 420 测试；format/lint/typecheck/build/check-size；禁面扫描（含 md 载体）。
- 未验证/未做：C5/C6/C7 复核（切片⑤）、基准复采、`fs.restore`、递归删除、网络通用撤销、符号链接 TOCTOU 彻底消除、Node permission audit 差异收集。
- 老项（未触发勿动）：根 `tests/` 类型检查缺口、standards/07 验收节补"交付物表逐条核对"、CI checkout 版本、ADR-0010 回滚与共享分区注册（冻结）。

## 下一步（按优先级）

1. 切片④收尾提交：分支 `feat/phase3-slice4-plugin-b-c` 已含全部实现与文档，待 merge（或与所有者确认提交粒度）。
2. 切片⑤：manifest 规范回填复核（`governance`/`trust`/R3 注记已在 03 稿带日期注记，复核漏项）→ C1~C7 逐条复核 → Phase 3 阶段报告（收口物：报告 + `phase-3.end` tag 决定权归所有者）→ 基准复采（插件自身开销，只测不设阈值）。
3. 切⑤不另立设计稿（修订直接落 manifest 稿/ADR，见合同 §7 注记）。

## 关键提醒（坑/规范/易错点）

- **测试收集范围少一层 glob = 测试静默不跑**：[P-016](pitfalls/P-016-测试收集范围少一层glob等于测试静默不跑.md)——"全绿"先问跑了多少文件;报告同时报文件数。
- **投影不是镜像**：事件追加字段必须同时改写入、投影、过滤点；[P-015](pitfalls/P-015-事件写了字段不等于投影读得到.md)。
- **宿主装配时序**：serve 先于 alloc → [P-002](pitfalls/P-002-集成测试装配接线四类错.md)；真子进程显式栅栏 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)；红测先行/绿色验真 → [P-007](pitfalls/P-007-绿色要当场验真.md)；跨边界序列化丢东西 → [P-009](pitfalls/P-009-跨边界序列化会静默丢东西.md)；中文文案 ASCII 双引号 → [P-011](pitfalls/P-011-中文文案里的ASCII双引号截断字符串.md)；自研 Schema 动态键 → [P-014](pitfalls/P-014-自研Schema子集把动态键映射当成已支持.md)。
- 文档红线：ADR 只增不改（日期注记可）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 非技术且新在前；handoff 滚动 5 份（现 H-028~032）。
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-016）；方法索引：[skills/](skills/README.md)（S-001）。
