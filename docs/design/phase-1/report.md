# Phase 1 阶段进度报告（写给非技术读者）

- 状态：定稿（阶段验收执行完毕：八条场景逐条实测，五条一票否决项全过）
- 日期：2026-11-02（阶段验收轮）
- 本阶段目标（一句话）：交付一个可运行的 Keel 最小闭环——内核四件套 + 进程级执行单元 + 清单装配 + 补偿回退 + 策略插话点 + 旧生态适配原型，并在真实执行中复验旧系统六个病症（V1~V6）。
- 关联：[phase-1-mvp](../../roadmap/phase-1-mvp.md)（验收场景 A1~A8）；[04 稿](04-cli-benchmarks-fixtures.md)（命令面与基准口径）；[05 稿](05-cordis-adapter-prototype.md)（适配原型口径）

## 结论（一句话）

八条验收场景全部通过，其中 A1（并发规模）与 A6（审计归因）在本轮补齐**规模级实测**；验收过程发现并修复一处展示层缺陷、登记四项已知限制；交付物清单齐备（旧生态适配原型为本轮补齐的最后一项）。**具备打 `phase-1.end` 的条件。**

## 完成了什么（本轮验收动作）

- 把"纸面通过"的两条规模级主张跑成真实执行：20 个会话同时运行并各自动态增删工具（A1）；任选一个真实运行，把它的整条决策流水从账本重放出来并逐条核对归因（A6）
- 补上内核唯一收费关卡的**真实进程**实测：执行单元里没有任何绕过模型网关的路径，越权调用在扣额度之前就被拒绝且留痕（A7）
- 补齐交付物最后一项：旧框架写法 `ctx.tools.register()` → 按会话注册的接口级原型，并让它成为 A1 动态增删的施加通道（旧迁入路径与内核隔离一次验证）
- 阶段验收报告收口：A1~A8 逐条结果、证据、发现与限制、体量与规范复查

## 验收场景执行结果

| 场景                               | 结果 | 证据与一句话说明                                                                                                                 |
| ---------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| A1【一票否决】（V1）20 会话并发    | 通过 | `tests/concurrent-scope-isolation.test.ts`（真实进程，3 次复跑一致）：各域工具表互不可见、指纹只因自身增删而变、零跨会话污染     |
| A2【一票否决】（V2）插件崩溃隔离   | 通过 | `tests/cell-crash.test.ts` + `keel scenario a2`×3 PASS：崩溃舱失败（CELL/CRASH），并行舱正常收束                                 |
| A3【一票否决】（V3）中断后恢复延续 | 通过 | `tests/cell-crash-recovery.test.ts` + `keel scenario a3`×3 PASS：计划给出一致点轮 2 + 未决 2 笔 + 快照 v1，新运行号延续          |
| A4【一票否决】（V4）回滚三路径     | 通过 | `tests/tool-failure-compensation.test.ts` + `keel scenario a4`×3 PASS：撤销闭环 / 恒败升级阻断 / 仅记录降级 + 重派无害           |
| A5（V5）热装配升级与回退           | 通过 | host 三份单测 + `keel scenario a5`×3 PASS：负路径 6/6 全拒、样例 2/2 全过、迁移钩失败回退旧版本后仍可原子切换到 1.1.0            |
| A6【一票否决】（V6）审计归因可重放 | 通过 | `tests/audit-attribution-replay.test.ts`（真实进程）+ `keel replay` 子进程复演同一运行：51 条事件连续无缺、每次插话成对留痕      |
| A7 预算权威记账 + 直连路径拒绝     | 通过 | `tests/gateway-fail-closed.test.ts`（真实进程）+ core 网关/预算/授权单测：越权模型调用零预扣零上游调用，合法调用 100 扣 60 退 40 |
| A8 质量门禁与基准                  | 通过 | 六道门禁全绿（225 项测试）；契约 §9 五测试点核对见 §4；四项基准复采数据见 §5                                                     |

> 一票否决五项（A1/A2/A3/A4/A6）逐条通过，其中 A1、A6 为**本轮补执行**的规模级实测。

## 1. A1 规模复演：口径与数据

**"缓存命中率稳定"的可执行口径**（契约 §9 V1 条原文为"缓存命中率不受扰动"）：把某会话某轮看到的工具表序列化为**指纹**（`名字@版本` 升序拼接，等价于模型侧的工具表缓存键）。主张即为——未自己增删工具的会话，其指纹跨轮**恒定**（邻居的变更不造成本域失效）；自己动过的会话，指纹变化轮次严格等于自身剧本的生效轮次。

20 个会话（每会话一个独立 OS 进程），每会话 5 轮，增删动作经适配原型 `ctx.tools.register()/remove()` 施加；其中 4 个会话为"静止对照"（全程不动）：

| 观测项                        | 结果                                                      |
| ----------------------------- | --------------------------------------------------------- |
| 并发执行单元数 / 事件总量     | 20 个 / 708 条（3 次复跑逐项一致）                        |
| 跨会话污染                    | 0（他域工具名在任何本域事件里都不出现）                   |
| 静止对照会话的指纹种数        | 1（五轮零扰动）                                           |
| 变更会话的指纹变化轮次        | 恰为 [2, 3, 4]（与自身剧本逐轮吻合，无多无少）            |
| 变更事件条数（每 run）        | 变更会话 5 条、静止会话 2 条，全部 `affectedScope` = 本域 |
| 端到端耗时 / 宿主常驻内存增量 | 209~258 ms / 6~7 MiB                                      |

结论：全局注册污染在结构上不可复现（不是"测试里没发生"，而是接口没有那个参数位）。风险簿"进程隔离内存压力"一项在 20 舱尺度未见压力（宿主侧增量个位数 MiB；池化触发条件仍无迹象）。

## 2. A6 归因复演：一个真实运行的完整决策流水

被测运行 = 5 轮、四条分支：放行 / 内核授权拒绝 / 策略插话否决 / 模型首败后按插话建议重试成功。写侧收束后由**冷实例**读账本（跨进程重启的可读性一并验证），再用交付入口 `keel replay` 复演。

```text
   1 ASSEMBLY_RECORDED      manifest={"name":"a6-demo","version":"1.0.0","kind":"capability"}
   2 RUN_STARTED            {}
   4 DECISION               round=1 summary="a6-r1" basedOn=[1,2,3]
  15 HOOK_VERDICT           hook=stopAdvice round=2 verdict={"suggestStop":false,...}
  17 AUTH_DENIED            subject=agent-a6 tool.invoke ghost reason="no allow rule matches ... (policy p-a6)"
  18 TOOL_RESULT            round=2 tool=ghost status=error 0ms error={"code":"AUTH/DENIED","by":"core",...}
  26 HOOK_VERDICT           hook=toolApproval round=3 verdict={"verdict":"deny","reason":"policy: risky is blocked"}
  27 TOOL_RESULT            round=3 tool=risky status=error 0ms error={"code":"AUTH/DENIED","by":"policy-hook",...}
  38 HOOK_VERDICT           hook=retryAdvice round=4 verdict={"policy":"retry","backoffMs":0}
  39 BUDGET_RESERVED        req=m1#2 estimate=100 runLeft=900
  42 MODEL_USAGE            req=m1 usage={"tokens":12} cost=60
  51 RUN_HALTED             {"reason":"completed"}
```

核对结论（五条）：① seq 1..51 连续无缺口、归属单一运行、终态收束；② 8 次插话全部成对留痕（`fallback=false` = 裁决有效而非超时回落）且都改变了走向——否决的两支没有 `TOOL_INVOKE`（未执行即无执行痕迹），重试支派生 `m1#2` 新预扣并只落一次 `MODEL_USAGE`；③ 内核拒绝留痕字段齐备（主体/动作/资源/策略版本/理由）；④ 每轮决策的 `basedOn` 只引用**已发生**事件，并覆盖上一轮全部插话 seq（因果不倒挂、插话可归因）；⑤ 交付入口输出 52 行（摘要 + 逐事件一行），人可直接读。

## 3. 验收轮发现与处置（坏消息优先）

1. **已修复（展示层缺陷，复现测试先行）**：`keel replay` 的预算实结行错取字段名（`reqId` 不在该事件载荷里）→ 输出 `req=undefined`，审计员会误读为"这笔结算没有对应请求"；改为显示 `res=<预留号>`。同时 `TOOL_SCHEMA_CHANGED` 原先走默认分支被 100 字符截断，恰好丢掉最关键的 `affectedScope` → 单列格式。复现与防回归测试在 `tests/audit-attribution-replay.test.ts` 第⑤条。
2. **登记限制（不阻断验收）**：`DECISION.basedOn` 只覆盖**调度器写入**的事件；授权器/网关/效果追踪器直写的 `AUTH_DENIED`、`EFFECT_*`、`STATE_SNAPSHOT_REF` 等不入依据集（上例 seq 17 即缺席）。账本 seq 全序仍连续可重放，归因由"全序 + 事件类型"承载；若要把依据集扩到"决策前全部事件"，属契约 §4.1/§5 语义变更，须先开 ADR（Phase 2 前评估）。
3. **登记限制**：本轮 A6 的策略插话由内核注册面（`HookBus.register`）接进，**策略插件 → 插话总线**的装配链仍未接（切片⑤既有回填项）。故 `keel run` 直接跑出的真实运行暂无插件来源的插话痕迹；"每次插话可归因"的主张由本测试与内核单测共同承载。
4. **登记限制**：快照仍为宿主内存持有（无物理持久化），A3 的 kill→计划→执行发生在同一宿主进程内；跨宿主重启的恢复未实测。
5. **交付物补齐**：适配原型此前是空占位文件（Phase 1"做"清单与交付物表都列了它）。本轮按 [05 稿](05-cordis-adapter-prototype.md) 补接口级原型（142 行含注释）+ 9 项单测，并作为 A1 增删动作的施加面——旧写法迁入后仍受同一套 scope 分区约束。

## 4. 契约级测试点核对（01 稿 §9 五点）

| 测试点                   | 主张                             | 背书（验收轮更新）                                                                                                                                         |
| ------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V6 Agent Loop 不可插件化 | hook 响应禁区 + 介入可归因       | `packages/core/test/hooks.test.ts`（禁区字段拒绝 → fallback + 双留痕）；新增 `tests/audit-attribution-replay.test.ts`④（basedOn 覆盖上轮裁决、因果不倒序） |
| V3 统一账本 + 恢复       | kill → 计划 → 执行，新运行号延续 | `tests/cell-crash-recovery.test.ts` + `keel scenario a3`×3（`RUN_RECOVERED{recoveredFromSeq}`、快照挂载读到旧状态）                                        |
| V1 无全局注册污染        | scope 首参 + 互不可见            | `packages/core/test/context.test.ts`；新增 `tests/concurrent-scope-isolation.test.ts`（20 域规模级）+ 适配原型单测（同名条目按域各记版本）                 |
| 预算权威记账             | 同 id 重放不重复计费 + 差额退还  | `packages/core/test/gateway.test.ts`、`budget.test.ts`；新增 `tests/gateway-fail-closed.test.ts`（真实进程：上游恰好 1 次、重放标记为真）                  |
| 拒绝留痕                 | 拒绝必有事件 + 插话超时回落      | `packages/core/test/authorizer.test.ts`、`packages/host/test/cell-server.test.ts`；新增 A7 集成（越权模型调用零预扣零调用 + 留痕）                         |

## 5. A8 基准数据（验收轮复采；口径见 04 稿 §3，只建测量不调优、无阈值断言）

测量环境：Windows 11（win32/x64）、Node v26.13.0、开发机单机（`keel bench` 一键采集）。

| 指标                      | 口径                                                 | 结果（复采 / 切片⑤首采）         |
| ------------------------- | ---------------------------------------------------- | -------------------------------- |
| B1 账本吞吐               | 单 run append 2000 事件（warmup 100），缓冲写        | 24548 events/s（81.5 ms）        |
| B1b 一致点                | `ledger.checkpoint`（fsync ×2 语义）×20              | 0.84 ms/次                       |
| B2 网关延迟               | 全链（授权→预扣→上游→实结→落账），mock 即时上游 N=50 | min/p50/p95 = 0.2 / 0.2 / 0.2 ms |
| B3 Cell 冷启              | `spawnCell` → 首次工具往返（真实 Node 子进程）N=5    | min/p50 = 36 / 37 ms             |
| B4 补偿编排延迟（观测项） | 一批 K=8 效果 record-only 直闭 ×3                    | 1.5 / 0.7 / 0.7 ms               |

初读不变：三个 ADR 重评条件（账本引擎独立化 / 网关旁路计量 / Cell 池化）均无触发迹象；两次采集数字同一量级，波动在测量噪声内。A1 规模复演补充一个 B3/B2 之外的并发数据点：20 舱 ×5 轮端到端 ~0.2 s。

## 6. 架构接缝核对

- architecture/01 §4~§5 的接缝逐项对照：控制面（内核四件套 + 网关 + 插话点）已落地并跑真实负载；执行单元（进程后端 + `IsolationProvider` 抽象）已使用，容器后端预留未触达（Phase 1 明确不做）；补偿（状态机全路径）已使用；插件装配（五步校验 + 热装配）已使用；兼容层（Cordis 适配）接缝以原型形态首次使用
- 不变量核对：I1 账本单写者（A6 逐轮 seq 全序）、I2 舱间不级联（A2/A1）、I3 轮边界一致点先于轮收束（A3 计划锚）、I4 默认拒绝（A7）、I5 无全局注册表（A1 + 适配原型）——五条均有本轮回执，无纸面接缝
- 未发现需要修订架构文档的偏差；`basedOn` 依据集范围（§3 第 2 条）若将来扩大，落点是契约稿而非架构篇

## 7. 体量核对（standards/08）

- docs/：本轮新增 1 篇（design/phase-1/05）/ 总数 27 篇（软上限 150）；超限篇目：无（新稿 66 行 ≤500；本报告为 design 目录，长度在 500 行上限内）
- .agents/：文件数 11（上限 40）；CONTEXT 行数：本轮收尾重写（上限 150）；handoff 滚动 5 份保持
- 代码：新增 >600 行文件：无；单文件最大 569 行（`packages/core/src/scheduler.ts`，切片④即此值）；本轮新增源码 142 行（适配原型）+ 测试 951 行（tests/ 三份 + 原型单测）
- 依赖：新增 0 个三方运行时依赖（仅把 workspace 内部包 `@keel/cordis-adapter` 挂到根 devDependencies 供集成测试解析）；零运行时依赖姿态保持
- 构建产物：412 KB（软上限 500 MB）；无提醒、无阻断
- 豁免登记：无

## 8. 规范复查（standards/09 四问，逐篇结论）

- **有漏洞吗**：一处——验收轮暴露"交付物清单与施工完成度"之间没有机械核对（适配原型空占位一路通过六道门禁，因为门禁只测代码与文档体量）。处置：阶段验收必须逐条比对 phase 文档 §4 交付物表，本报告 §3 第 5 条即该核对的产物（建议把这句话补进 standards/07 的验收节，下一轮规范修订处理）。
- **过严吗**：无发现（零豁免）。
- **过松吗**：一处——`tests/` 目录不在 `pnpm typecheck` 覆盖范围内（各包的 tsc 只覆盖自身 src+test），集成测试的类型错误只能靠运行时暴露。本轮未踩到，但登记为待改进（处置建议：根加一条 tsc 项目或纳入 lint 的 type-aware 规则）。
- **冗余或矛盾吗**：无发现（05 稿与 manifest 稿 §"不覆盖"、04 稿与本报告 A8 节为引用式分工）。
- 其余篇目（01/02/03/04/05/06/08）逐篇过一遍：无发现。

## 9. 已知问题与风险

- 坏消息优先：§3 的 4 条限制中，第 3 条（策略插件未接插话总线）影响 A6 在**交付入口**上的完整呈现，Phase 2 动策略生态前必须回填；第 4 条（快照无持久化）影响跨宿主重启恢复主张，Phase 2 若有长跑需求则升级为功能项
- 规范复查两条发现（交付物核对无机械强制、tests/ 不类型检查）登记为下一轮规范/门禁改进，不阻断收官
- 风险簿（roadmap §4）六项：本轮 A1/A4/A8 提供了实证数据，无新增风险；"进程隔离内存压力"等级在 20 舱尺度可维持低位（池化仍留 backlog）
- 未决（所有者）：版权署名占位（LICENSE + 两份 README + ADR-0006 仍署"Keel Project Contributors"）。git 远端已于收官当日启用（私有 GitHub 仓库 + 门禁流水线）；**本报告的规模级数据全部来自 Windows 开发机**——远端流水线首跑在类型检查步骤拦下一处既有缺陷（干净检出无构建产物 → 跨包类型解析落空，本机因产物残留不可见），修复见 CHANGELOG 0.1.021，Linux 侧的全量绿灯以修复后的流水线为准

## 10. 对下阶段的影响

- Phase 2（Cordis 兼容层）前置条件变化：适配原型已在环内，Phase 2 可从"接口原型"起步而不是从空白起步；其第一份硬前置仍是**显式迁移边界文档**（roadmap 风险簿要求）
- 回填清单（Phase 2 开工前先清）：策略插件 → 插话总线装配链、`model.stream` 流式通道（契约 §4.7）、旧执行单元 drain 完整语义、快照物理持久化、`basedOn` 依据集范围（需 ADR）
- backlog 未变（probe 通道、builtin 补偿动作、退避参数可配置面、migration 多步链、未决污染清单 CLI、Cell 池化）——本轮基准与 A1 数据均未触发其条件

## 11. 文档更新清单

- 新增：design/phase-1/05-cordis-adapter-prototype.md（本轮）；本报告由"编制中"重写为验收收口版
- 修订：docs/README.md（登记 05 稿 + 报告状态）、roadmap/00-roadmap.md（Phase 1 → 完成）、roadmap/phase-1-mvp.md（A1~A8 勾选）、packages/cordis-adapter/README.md（占位 → 原型落地）、CHANGELOG（新增一条里程碑）
- 代码：`packages/cordis-adapter/src/index.ts` + 单测；`tests/concurrent-scope-isolation.test.ts`（A1）、`tests/audit-attribution-replay.test.ts`（A6）、`tests/gateway-fail-closed.test.ts` + `tests/fixtures/fail-closed-plugin.mjs`（A7）；`apps/keel/src/cmd-replay.ts`（§3 第 1 条修复）；根 package.json（测试解析用 workspace 内部依赖）
