# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**Phase 4 切片①收口——四份设计稿过闸、四篇 ADR、K6 扫描扩展落地**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（提前收口）/ Phase 3 ✅（验收收口，`phase-3.end` tag 已打）
- **Phase 4 进行中，切片①完成**（分支 `docs/phase4-charter`，未 merge）：
  - 合同定稿（K1~K6 所有者确认）；拓扑 ADR-0021 定稿（选统一流）
  - 四份设计稿定稿：`docs/design/phase-4/01-profile-assembly` / `02-model-kind` / `03-engine-kind` / `04-contract-revision`（所有者"四稿通过"）
  - ADR-0022（manifest 扩 model/engine）/ 0023（`engine.step`）/ 0024（表面事件族）定稿
  - K6 禁面扫描扩展已落地（六条按 kind 判据 + 门禁用例），六道门禁全绿
- 设计输入：`docs/research/01`（DSH 数据流，冻结）、`docs/research/02`（DeepSeek API 现状，冻结）

## 本轮关键结论（别丢）

- **拓扑**：账本唯一事实；模型可见内容 = 表面事件族（`TURN_INPUT` / `MODEL_MESSAGE` / `TOOL_RESULT`）的纯投影；治理事件永不进视图；`surfaceOp` 预留不实现
- **费用权威**：价格表进 model manifest（按模型分表、三桶 `inputCached`/`inputUncached`/`output`、峰谷两档）；模块只报 usage，Core 计价结算；节假日不建模、保守落峰价
- **模型治理三层**：总时限（既有 120s/300s）+ 可选空闲看门狗 + 单次超支不把预算打成负数
- **engine 分工**：决策在 Cell、推进在 Core，每步一次 `engine.step`；**不新开 Cell→Core 工具执行通道**；engine 无状态、无写账本入口
- **profile**：`profile.yaml` 严格 YAML 子集（零依赖）；六步装配、全就绪才受理、未声明零加载、失败整份拒绝；装配记录逐插件 N 条 + `profile`/`plugin` 字段
- **provider 事实**：`deepseek-chat`/`deepseek-reasoner` 已停用，现行 `deepseek-flash`/`deepseek-v4-pro`；思考模式默认开启，带工具必须回传 `reasoning_content`（已进表面消息形状）

## 已验证 / 未验证

- 已验证：六道门禁全绿（format / lint / typecheck+build / test **56 文件 422 测试** / scan 实扫零命中）；扫描器毒样本逐条命中、干净 engine/model 样本零误伤
- 未验证/未做：04 稿 R1~R13 的代码实施（schema/装配器/契约/网关计价/`engine.step`）全部在切片②③④；profile 解析器与六步装配尚未写

## 下一步（按优先级）

1. **切片② Profile 装配面**：R9/R10/R11/R12/R13 先行——schema 扩 kind + 两段 if/then、装配器语义校验（engine 能力白名单、`auth.ref` presence-only、价格表键集合、`maxSteps` 区间）、`profile.yaml` 子集解析器、六步装配、逐插件装配记录；**红测先行**（`tests/profile-assembly-e2e.test.ts`）
2. 切片③ model kind：R1/R4/R5（表面事件、`MODEL_USAGE` v3、计价与超支）、mock 标杆 + DeepSeek 真适配器（不进 CI）
3. 切片④ engine kind：R6 `engine.step`、ReAct 标杆、D3 真进程与 kill 故障半径、报告收口

## 关键提醒（坑/规范/易错点）

- **改文本只用 edit/write 工具**：PowerShell in-place 替换会毁编码与换行（[P-017](pitfalls/P-017-powershell改写破坏编码.md)），本轮已踩一次
- **外部事实必须带来源 URL + 检索日期**，停用值只许出现在"已停用"说明里（[P-018](pitfalls/P-018-外部API事实过期.md)）；`briefs/` 只作输入，对齐后沉淀 `docs/research/`
- **ADR 只增不改**；docs 新增必须登记 `docs/README.md`；CHANGELOG 新在前、面向非技术读者（本轮 0.1.051~0.1.054）
- **体量**：docs 74 篇（软上限 150，本阶段 +10）；`.agents` 33 个文件（上限 40）；CONTEXT ≤150 行
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-018）；方法索引：[skills/](skills/README.md)（S-001）
- 设计稿纪律：凡借 DSH "流的形状"处写三栏（DSH 实况 / Keel 对应 / 差异理由）；改白名单/错误码/op 一律先 ADR
- `phase-3.end` 已打；`docs/phase4-charter` 分支待所有者决定 merge 时机
