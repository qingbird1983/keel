# CLI 验收入口、A8 基准口径与 fixtures 收全

- 状态：定稿（2026-11-02 所有者确认切片⑤方案：bench 子命令 / scenario 一键复演 / 纳入最小 replay / validate+hotswap 双命令）
- 日期：2026-11-02
- 关联：[phase-1-mvp](../../roadmap/phase-1-mvp.md)（交付物与验收 A1~A8）；[01-core-api-contract](01-core-api-contract.md)（§9 契约级测试点、§5 事件表）；[02-compensation-state-machine](02-compensation-state-machine.md)（§13 定案）；[03-plugin-manifest](03-plugin-manifest.md)（§8 A5 负路径）；ADR-0004（基准重评条件）

## 1. 背景

切片①~④已落 A1~A6 的实现与测试主张；本切片交付三件横向收口物：**apps/keel CLI**（验收场景执行入口，脚手架已占位）、**A8 基准**（测量不调优，数据供 backlog 重评决策）、**fixtures 三组收全**（schema 负路径 / 账本回放 / 补偿桩）。本文是这三者的实现口径，实现以本文为准。

## 2. CLI 命令面（apps/keel）

定位（apps/keel/README.md 既有约定）：**薄壳**——只做参数解析与编排调用，业务逻辑全部下沉 packages/。

| 命令            | 参数                                                            | 对应验收     | 行为摘要                                                                                                                                               | 退出码                     |
| --------------- | --------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `keel run`      | `--manifest <path> --plugin <path> [--data-dir <dir>]`          | A1/A2 载体   | 装配 manifest → demo Run（内置最小 driver：调 manifest 工具 N 轮后 halt）→ 打印 runId / 终态 / 事件摘要                                                | 0 终态 halted；1 失败      |
| `keel recover`  | `--data-dir <dir> --run <runId>`                                | A3           | `recovery.plan` 打印一致点 / 未决清单 / 快照 → `execute` 延续（内置延续 driver）→ 打印新 runId 与 RUN_RECOVERED 确认                                   | 0 恢复成功；1 失败         |
| `keel replay`   | `--data-dir <dir> --run <runId>`                                | A6           | `ledger.read` 全量 → 按序单行格式化决策序列（DECISION / AUTH_DENIED / HOOK_* / TOOL_* / BUDGET_* / MODEL_* / EFFECT_* / COMPENSATION_*）；纯展示无断言 | 0 有事件可读；1 run 不存在 |
| `keel validate` | `--manifest <path>` 或 `--dir <组目录>`，可加 `--expect reject` | A5 结构+语义 | 逐文件过装配五步（Schema 注入自 docs/design/phase-1/schema/）；`--dir` 批量；`--expect reject` 时任一文件未被拒 → exit 1                               | 0 符合期望；1 不符合       |
| `keel hotswap`  | `--manifest/--plugin ×2`（v1→v2）                               | A5 (V5)      | bind v1 → hotSwap v2（migration 钩失败桩）→ 断言回退旧绑定并继续服务 → 打印回退结果                                                                    | 0 回退正确；1 异常         |
| `keel bench`    | `[--rounds <n>]`                                                | A8           | 四项基准（§3）→ markdown 表格输出                                                                                                                      | 0 完成                     |
| `keel scenario` | `<a2\|a3\|a4\|a5>`                                              | A2/A3/A4/A5  | 一键复演：装配 tests/fixtures 桩 → 执行 → 断言关键账本事件存在性 → PASS/FAIL + 证据行（§5）                                                            | 0 全 PASS；1 有 FAIL       |

通用约定：

- **数据目录**：一次性命令（run / hotswap / bench / scenario）缺省用自动清理的临时目录；跨会话命令（recover / replay）必传 `--data-dir` 指向既有账本根。fixtures / schema / cell-runtime 入口路径一律 `import.meta.url` 上溯解析，不依赖 cwd。
- **前置检查**：`packages/cell-runtime/dist/main.js` 不存在 → 明确报错提示先 `pnpm build`（子进程只能跑 dist）。
- **薄壳红线**：命令层不做业务决策；scenario 的断言 = 账本事件存在性检查（读账本、查事件、比对终态），不重复实现包语义。
- **装配复用**：`runtime.ts` 提供 buildRuntime / wireRun 两原语（接线序 = tests/ 三份集成 rig 同构：Ledger→Authorizer→Budgeter→Context→HookBus→Gateway→Scheduler→SnapshotStore→CompensationExecutor→RecoveryManager→Supervisor；每 run spawnCell→serveCellChannel（全套 deps）→ctx.alloc→start→attachRun→await done→drainAndReap）。

## 3. A8 基准口径

合同要求（phase-1-mvp §3/§5）：**三项基准**（账本吞吐 / 网关延迟 / Cell 冷启动）数据入 `docs/design/phase-1/report.md`；补偿编排延迟为 02 稿 §12 建议的观测项，一并采集。**只建测量，不调优，无阈值断言**；数据供 ADR-0001/0003/0004 的 backlog 重评条件消费。

| #   | 指标                   | 口径                                                                                                          | 采样                                        |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| B1  | 账本吞吐               | 单 run 连续 append N=2000 事件 → events/s；另测 20 次 `ledger.checkpoint`（fsync 语义）端到端耗时             | warmup 100 后计时                           |
| B2  | 网关延迟               | `ModelGateway.invoke` 全链（预扣→上游→实结→审计落账），upstream 为进程内即时 mock（测网关壳层开销，不含网络） | warmup 10 + N=50 样本，报 min/p50/p95（ms） |
| B3  | Cell 冷启动            | `spawnCell` → 子进程 ready（真实 Node 子进程，冷启每批一次）                                                  | N=5，报 min/p50/p95（ms）                   |
| B4  | 补偿编排延迟（观测项） | 一批 K=8 效果 record-only 直闭的 `compensate(run)` 总耗时（含投影重放 + 分波编排）                            | N=3，报各次耗时（ms）                       |

- 计时用 `process.hrtime.bigint()`（真实时钟）；基准**不进 vitest CI**（数字波动，且 standards/05 确定性要求针对测试而非测量脚本）；报告须注明环境（OS / Node / 机器概况一行）。
- 结果落 `report.md`：A8 数据表 + 口径引用本文 §3。

## 4. fixtures 三组收全

| 组              | 位置                                                                 | 收全清单                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| schema 负路径组 | `fixtures/manifest-negative/`                                        | §8 四类实体化：`missing-net-allow.json`、`boundary-no-template.json`、`policy-with-permissions.json`、`hook-unknown-name.json`；+2 结构负例：`bad-meta-name.json`（name 违 pattern）、`unknown-top-field.json`（additionalProperties:false）；`README.md` 逐枚标预期拒绝原因与装配五步归属。host 测试：读目录批量 assemble → 全部 `SCHED/MANIFEST-INVALID`（补齐此前未测的 policy-permissions / hook-白名单两条）                          |
| 账本回放组      | `fixtures/ledger/`（既有 replay-basic 保留）                         | +`replay-decision-sequence/`（A6 复演样例：一个 run ~16 事件全决策链，payload 逐字段对齐 core events.ts 类型）；+`replay-multi-seg/`（seg-000001/000002 跨段 seq 连续）；+`replay-torn-tail/`（末行撕裂负例：冷读丢弃撕裂行、其余可读）。core ledger.test.ts fixture 回放组逐样例断言"旧样例可读且语义不变"（standards/05 §2.3）                                                                                                           |
| 补偿桩组        | `tests/fixtures/`（compensate-plugin.mjs 扩 + 新 migration-fail 桩） | compensate-plugin +3 handler：`always-slow`（补偿动作超时分类）、`dedup-keyed`（按 effectId 真实去重计数，证重派无害）、`mitigate`（mitigable 缓解桩）；`fail-with-effect` 工具 +`dependsOn` 可选透传（真实进程依赖链）。+新 `migration-fail-plugin.mjs`（v2 manifest migrate 抛错，服务 hotswap / scenario a5）。probe-guarded 与 `action.type:"builtin"` 桩**不收**——执行器侧 probe 通道与 builtin 分发未实现（backlog），桩先行即死资产 |

## 5. 实现期定案（2026-11-02 切片⑤）

1. **scenario 断言语义** = 账本事件存在性检查（类型 + 关键 payload 字段 + 终态），不复制包内逻辑；证据行直接引用账本原文供 report.md 抄录。
2. **report.md 落点（本切片）**：A8 四项基准数据表 + 契约 §9 五测试点逐条核对记录 + A1~A7 各条覆盖方式指引（指向 tests/ 三份集成与 CLI scenario）；完整逐条验收（一票否决标记核对）留阶段验收执行。
3. **A5 复演深度**：validate 覆盖结构 + 四类语义负路径；hotswap 以真实装配演示 V5 回退（迁移钩失败 → 新 Cell 丢弃、旧作用域继续服务、账本无全局突变）。
4. **replay MVP**：纯读 + 格式化，无重放执行语义（不驱动任何组件）；A6"完整决策序列可重放"的主张由账本全留痕 + 本命令的可读性承担。
5. **CLI 测试分层**：apps/keel/test/ 命令层冒烟（直接调用导出命令函数 + 一条 execFile bin 冒烟）；内核行为主张不重复——仍归 tests/ 三份集成与各包单测。
6. **CLI 依赖**：@keel/core / host / cell-runtime（workspace:*）；@types/node 供进程 API（standards/04 §CLI 条）；零新增三方运行时依赖。

## 6. 风险

| 风险                                       | 预案                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| 手写账本 fixture payload 与 events.ts 漂移 | 以 core 类型导出逐字段核对；core 测试断言兜底（可读 + 关键字段语义）   |
| CLI 真实进程测试依赖 dist                  | beforeAll 检查 + 报错提示 `pnpm build`；README 开发节写明              |
| bench 数字波动误导决策                     | 无阈值断言；报告注明环境与样本数；重评条件在 ADR 不在数据本身          |
| scenario 体量膨胀（四场景编排）            | 断言共用 assertions 子模块；单文件 ≤600 红线，超了拆 per-scenario 文件 |
