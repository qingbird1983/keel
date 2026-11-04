# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**Phase 4 切片③收口——`kind:"model"` 计量/预算/超时/密钥红线端到端**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（提前收口）/ Phase 3 ✅（`phase-3.end` tag 已打）
- **Phase 4 进行中，切片①+②+③完成**（分支 `docs/phase4-charter`，未 merge）：
  - 切片①：合同/四份设计稿/ADR-0021~0024/禁面扫描扩展
  - 切片②：Profile 装配面端到端（六步装配、五 kind 隔离、逐插件记录、`keel validate/run --profile`）
  - 切片③：model kind——Core 按 manifest 价格表三桶/峰谷计价、`MODEL_USAGE` v3、超预扣不穿透预算、
    非流式 120s + 流式断流 + 模块内空闲看门狗、表面事件族白名单；mock 进 CI / DeepSeek 手动
- 设计输入：`docs/research/01`（DSH 数据流，冻结）、`docs/research/02`（DeepSeek API，冻结）

## 本轮关键结论（别丢）

- **费用权威在 Core**：model 模块只报 `{inputCached,inputUncached,output}`；价格表在 manifest
  `model.pricing.<型号>`（三桶 × 峰谷两档，UTC 窗口），`Σ(bucket×价)/1e6`；模块带 `cost` =
  `UPSTREAM_PROVIDED_COST`；未注册模型名 = `MODEL_NOT_REGISTERED`（不回落演示桩）
- **注册面作用域**：一份 profile 内同名模型 = 整份拒绝；同一宿主重复装配用 `registerModel(...,{replace:true})`
  显式重绑（教训 P-020）。网关只放行已注册名字
- **预算不穿透**：`settle(actual > estimate)` → 用量夹到限额、`BUDGET_SETTLED{overrun:true}`、
  下一跳 `BUDGET/EXHAUSTED`；`MODEL_USAGE` 如实记真实金额；金额累加统一按 1e-12 收浮点尾（P-021）
- **三层治理**：非流式 120s（`invokeTimeoutMs` 仅测试缝）/ 流式总长 300s + 单次取片 30s（既有）/
  模块 `timeouts.idleMs`（≤300s，按分片 rearm）；所有失败先 settle 闭环再报错
- **流式计价**：模块每片报**累计**三桶，终局按最后一片计价；中间页不返回金额；坏 `cost` 片按断流闭环后拒绝
- **表面事件族（R1/R3）**：`TURN_INPUT` / `MODEL_MESSAGE` / `TOOL_RESULT` = 封闭白名单
  `SURFACE_EVENT_TYPES`；`MODEL_MESSAGE.reasoningContent` 是硬字段；`surfaceOp` 预留不实现；
  仅 Core 可写（`appendTurnInput` / `appendModelMessage`）
- **版本表**：`MODEL_USAGE` v3、`BUDGET_SETTLED` v2、`MODEL_INVOKED` v2（streamId）、`DECISION` v2

## 已验证 / 未验证

- 已验证：六道门禁全绿（format / lint / typecheck+build / test **62 文件 470 测试** / 扫描实扫五件套零命中）；
  D2（峰 1.4 / 谷 0.7、超支夹限、逐条对账）、D4（账本/记录/事件/诊断零密钥值）、D6（上游抛、120s 到点、
  用量不按桶、流中途抛、看门狗：`produced/cost/truncated` 全可对账）；D1-a~e 与既有回归零退化
- 未验证：`model-deepseek` 真实请求（本轮无密钥，仅编译+静态检查）；engine 驱动的 `run --profile`（切片④）；
  model-only profile 的 CLI 跑通仍用 demo driver（不经过引擎）

## 下一步（按优先级）

1. **切片④ engine kind**：R6 `engine.step`（`{runId,step,maxSteps,messages,tools,lastResult?}` →
   `{decision:{kind:"act",actions[]}|{kind:"done",summary}}`，300s 档）、R7/R8；ReAct 标杆在独立 Cell；
   E4 表面投影（只吃 `SURFACE_EVENT_TYPES`，消息形状 `{role,content,reasoning?,toolCalls?,toolCallId?}`）；
   D3 真进程 + kill 故障半径；`keel run --profile` 接引擎驱动；阶段报告收口
2. 有密钥后跑 `scripts/verify-model-deepseek.mjs`，补真实请求记录（仍不进 CI）
3. 收尾：`phase-4.end` tag 与分支 merge 时机归所有者

## 关键提醒（坑/规范/易错点）

- **注册表先定作用域**：[P-020](pitfalls/P-020-模型按名注册把跨装配重绑当成重复.md)——进程级按名注册，
  "一份 profile 内同名"与"同宿主再装配"是两种错误；测试复用 runtime 会把后者暴露出来
- **金额累加要收浮点尾**：[P-021](pitfalls/P-021-金额浮点求和噪声让预算断言飘.md)——写状态的那一处收口，
  断言直接比金额、不写容差
- **数值哨兵不要用 falsy**：[P-019](pitfalls/P-019-把0当缺省值导致空resources插件装载即崩.md)
- **Schema 只能用关键词子集**：[P-014](pitfalls/P-014-自研Schema子集把动态键映射当成已支持.md)
- **改文本只用 edit/write 工具**：[P-017](pitfalls/P-017-powershell改写破坏编码.md)；
  Windows 控制台输出中文是乱码，不代表文件坏了（用 read 工具核对）
- **外部事实必须带来源 URL + 检索日期**：[P-018](pitfalls/P-018-外部API事实过期.md)；
  `deepseek-chat`/`deepseek-reasoner` 已停用，只许出现在"已停用"说明里
- **ADR 只增不改**；docs 新增必须登记 `docs/README.md`；CHANGELOG 新在前、面向非技术读者（本轮 0.1.056）
- **体量**：docs 71 篇（软上限 150）；`.agents` 30 个文件（上限 40，不含 vendored）；CONTEXT ≤150 行
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-021）；方法索引：[skills/](skills/README.md)（S-001）
