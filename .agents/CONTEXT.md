# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**Phase 4 切片②收口——Profile 装配面端到端（D1-a~e）落地**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（提前收口）/ Phase 3 ✅（`phase-3.end` tag 已打）
- **Phase 4 进行中，切片①+②完成**（分支 `docs/phase4-charter`，未 merge）：
  - 切片①：合同/四份设计稿/ADR-0021~0024/禁面扫描扩展
  - 切片②：Profile 装配面端到端——R2 + R9~R13、六步装配、逐插件装配记录、五 kind 隔离环境、
    组合执行器按 scope 路由、`keel validate/run --profile`；D1-a~e 真进程全绿
- 设计输入：`docs/research/01`（DSH 数据流，冻结）、`docs/research/02`（DeepSeek API，冻结）

## 本轮关键结论（别丢）

- **Profile 是清单，manifest 是报关单**：profile 只写 `id/kind/manifest/module/scope`，不复制权限/补偿/密钥；
  路径相对 profile 文件解析，绝对路径拒绝；未知字段拒绝
- **YAML 只支持严格子集**：块映射/序列/标量/注释；锚点、别名、flow、多文档、块标量、重复键一律硬失败+行号
- **装配顺序**：1 解析 → 2 profile schema → 3 逐 manifest 五步校验+kind 交叉 → 4 按 kind 拉起 →
  5 就绪凭据（`cell.snapshot`）→ 6 全部就绪后才注册策略 hook；任一步失败 = 整份拒绝、零事件
- **五 kind 隔离**：capability/engine = Cell 子进程；policy = 策略舱；model = 宿主进程内模块；
  observation = 无运行时（模块零 import）
- **工具归属不靠 manifest 猜**：`wireCell` 的 `onToolChange` 回调按 `scope + tool` 建表；
  重名 = 整份拒绝；engine.tools 用真实注册结果复核"恰好一个提供者"
- **装配记录**：逐插件一条 `ASSEMBLY_RECORDED`，按声明序作为 run **首批**事件；载荷追加
  `profile{name,version}` / `plugin{id}`；单件 `--manifest` 路径仍是一条（旧账本可读）
- **model/engine manifest 语义**：engine 只允许 `model.adapter`；model 的 `auth.ref` 只查存在性
  （错误只写 ref 名）；价格表键集合 = models、三桶非负有限、`peak` 存在时 `peakWindows` 必填、
  `idleMs ≤ 300s`；engine `maxSteps` 1~100、tools 无重名、loop=react

## 已验证 / 未验证

- 已验证：六道门禁全绿（format / lint / typecheck+build / test **58 文件 442 测试** / 扫描实扫零命中）；
  D1-a~e 真进程（隔离环境 pid、逐插件记录、坏清单整份拒绝、跨 scope 不可见、绝对路径拒绝）；
  CLI 四条（validate accept/reject、run --profile、互斥参数）；既有 Phase 1~3 回归零退化
- 未验证/未做：model 上游尚未接进 `ModelGateway`（本片只验证宿主驻留与构造）；
  `engine.step` 与引擎驱动的 `run --profile` 属切片④；切片③的计价/预算/超支语义未做

## 下一步（按优先级）

1. **切片③ model kind**：R1（表面事件 `TURN_INPUT`/`MODEL_MESSAGE`）、R4（`MODEL_USAGE` v3：
   `usageBuckets`/`tier`/`pricedBy`，Core 按 manifest 价格表计价）、R5（三层治理：总时限 + 可选 idle
   看门狗 + 单次超支 `overrun` 不把预算打成负数）；`packages/plugins/model-mock` 进 CI +
   `model-deepseek` 手动验证不进 CI；红测先行 `tests/model-kind-e2e.test.ts`
2. 切片④ engine kind：R6 `engine.step`、ReAct 标杆、D3 真进程/kill 故障半径、含 engine 的
   `keel run --profile`、阶段报告收口
3. 收尾：`phase-4.end` tag 决定权归所有者；`docs/phase4-charter` 分支 merge 时机同样归所有者

## 关键提醒（坑/规范/易错点）

- **数值哨兵不要用 falsy**：[P-019](pitfalls/P-019-把0当缺省值导致空resources插件装载即崩.md)——
  `toolCallTimeoutMs: 0` 是合法值（engine/策略舱不受理 tool.exec），入口只校验类型/范围
- **Schema 只能用关键词子集**：[P-014](pitfalls/P-014-自研Schema子集把动态键映射当成已支持.md)——
  `minProperties` 等集合外关键词会整份拒绝；动态键集合（如 pricing）留给装配器语义校验
- **改文本只用 edit/write 工具**：[P-017](pitfalls/P-017-powershell改写破坏编码.md)；
  Windows 控制台输出中文是乱码，不代表文件坏了（用 read 工具核对）
- **外部事实必须带来源 URL + 检索日期**：[P-018](pitfalls/P-018-外部API事实过期.md)；
  停用模型名只许出现在"已停用"说明里
- **ADR 只增不改**；docs 新增必须登记 `docs/README.md`；CHANGELOG 新在前、面向非技术读者（本轮 0.1.055）
- **体量**：docs 78 篇（软上限 150）；`.agents` 31 个文件（上限 40）；CONTEXT ≤150 行
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-019）；方法索引：[skills/](skills/README.md)（S-001）
