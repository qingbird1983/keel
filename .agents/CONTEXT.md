# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**Phase 4 切片④收口——`kind:"engine"` 端到端 + 阶段验收 D1~D7**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（提前收口）/ Phase 3 ✅（`phase-3.end` tag 已打）
- **Phase 4 验收收口（切片①~④全部完成）**；分支 `docs/phase4-charter` 未 merge：
  - 切片①：合同/四份设计稿/ADR-0021~0024/禁面扫描扩展
  - 切片②：Profile 装配面（严格 YAML 子集、六步装配、五 kind 隔离、逐插件记录、`validate/run --profile`）
  - 切片③：model kind（manifest 价格表三桶/峰谷、`MODEL_USAGE` v3、超预扣不穿透预算、三层超时、表面事件族）
  - 切片④：engine kind（`engine.step` 每步一往返、纯投影上下文、`DECISION.basedOn` 含模型事件、
    kill 引擎舱故障半径、`engine-react` 标杆、`keel run --profile` 接引擎驱动、D1~D7 复核）
- 设计输入：`docs/research/01`（DSH 数据流）、`docs/research/02`（DeepSeek API），均冻结
- 阶段报告：`docs/design/phase-4/report.md`（D1~D7 全过）；tag / merge 时机归所有者

## 本轮关键结论（别丢）

- **控制权分层**：决策在 engine Cell（一步内调模型、返回 `{decision,message?}`），推进/工具执行/
  记账在 Core。**没有** Cell→Core 的工具执行通道；engine 无账本/表面写入口（结构上做不到）。
- **表面投影**：`projectSurface(events)` 纯函数、只吃 `SURFACE_EVENT_TYPES` 白名单
  （`TURN_INPUT`/`MODEL_MESSAGE`/`TOOL_RESULT`）；版本号 `SURFACE_PROJECTION_VERSION=1`；
  `TURN_INPUT` 由调度器经 `RunManifest.turnInput` 写。
- **关联键**：`TOOL_RESULT.toolCallId` ↔ `MODEL_MESSAGE.toolCalls[].id`；`DriverAction.toolCallId`
  优先用模型给的，缺省 Core 生成。
- **归因**：`DriverDecision.basedOn` 合并进 `DECISION.basedOn`（模型事件是网关直写，不在
  `h.events` 里）；`throughSeq` 仍由账本盖章。`haltReason:"MAX_STEPS"` → `RUN_HALTED{reasonCode}`。
- **失败映射**：`engine.step` 通道断 / 收尾拒新（`SCHED/BACKPRESSURE`）→ `RUN_FAILED{ENGINE_EXITED}`；
  超时 → `TRANSPORT/TIMEOUT`；预算 hard-stop → `BUDGET/EXHAUSTED`，graceful → `RUN_HALTED{BUDGET/EXHAUSTED-GRACEFUL}`。
  **错误码零新增**（reasonCode 是载荷级字符串）。
- **预算估算**：engine 无价格表，每步预扣单位 1；实结/超支仍在 Core。
- **P-022 修正**：profile 装配记录逐插件一条，补偿执行器必须合并**全部**记录的权限
  （原只读第一条 → 能力插件排在后面时 `fs.remove` 必然升级）。
- **模型名全局注册**：同一宿主多次装配同名模型 = 后装配者替换上游实例（P-020 延伸）；
  测试/多 profile 场景必须用同一份 model 声明或显式预期重绑。

## 已验证 / 未验证

- 已验证：六道门禁全绿（format / lint / typecheck+build / test **64 文件 485 测试** / 扫描实扫零命中）；
  D3 多步闭环 + 真写盘 + 补偿回放 + kill 故障半径；D5 归因与投影重算；D2 预算熔断；协议封闭三例；
  CLI 四插件全家桶经引擎驱动；Phase 1~3 承载测试零退化
- 未验证：`model-deepseek` 真实请求（无密钥，仅编译+静态检查）；`engine.step` 300s 到点语义
  （由网关/通道既有用例覆盖）；跨 run 会话/压缩/UI（合同 §2 不做）

## 下一步（按优先级）

1. 所有者决定 `phase-4.end` tag 与 `docs/phase4-charter` merge 时机
2. 有密钥后跑 `scripts/verify-model-deepseek.mjs`，补真实请求记录（仍不进 CI）
3. 下阶段立项：跨 run 会话持久化/压缩、`kind:"ui"`/桌面壳、多 Agent（均须先写 ADR / 走 backlog）
4. 既有欠账：根 `tests/` 不在任何包 tsconfig include 内（类型检查缺口）

## 关键提醒（坑/规范/易错点）

- **装配记录不止一条**：[P-022](pitfalls/P-022-装配记录逐插件化后补偿只读第一条.md)——任何按类型取
  `events[0]` 的读者都要重新核对
- **注册表先定作用域**：[P-020](pitfalls/P-020-模型按名注册把跨装配重绑当成重复.md)——一份 profile 内同名拒绝，
  同宿主再装配显式重绑
- **金额累加要收浮点尾**：[P-021](pitfalls/P-021-金额浮点求和噪声让预算断言飘.md)
- **数值哨兵不要用 falsy**：[P-019](pitfalls/P-019-把0当缺省值导致空resources插件装载即崩.md)
- **Schema 只能用关键词子集**：[P-014](pitfalls/P-014-自研Schema子集把动态键映射当成已支持.md)
- **改文本只用 edit/write 工具**：[P-017](pitfalls/P-017-powershell改写破坏编码.md)；
  Windows 控制台输出中文是乱码，不代表文件坏了（用 read 工具核对）
- **外部事实必须带来源 URL + 检索日期**：[P-018](pitfalls/P-018-外部API事实过期.md)；
  `deepseek-chat`/`deepseek-reasoner` 已停用，只许出现在"已停用"说明里
- **ADR 只增不改**；docs 新增必须登记 `docs/README.md`；CHANGELOG 新在前、面向非技术读者（本轮 0.1.057）
- **体量**：docs 75 篇（软上限 150）；`.agents` 34 个文件（上限 40，不含 vendored）；CONTEXT ≤150 行
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-022）；方法索引：[skills/](skills/README.md)（S-001）
