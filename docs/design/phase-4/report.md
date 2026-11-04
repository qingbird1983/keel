# Phase 4 阶段进度报告（写给非技术读者）

- 状态：定稿（阶段验收 D1~D7 逐条复核完毕，两条一票否决项全过）
- 日期：2026-11-04（切片④验收轮）
- 本阶段目标（一句话）：让"万物皆插件"从主张变成可运行的事实——**一份清单拉起引擎、模型、能力、策略全家桶，跑通一个真进程、全治理、账本脊柱完整的 headless 闭环**。
- 关联：[合同](../../roadmap/phase-4-profile-engine-loop.md)（验收 D1~D7）；[01 稿](01-profile-assembly.md) / [02 稿](02-model-kind.md) / [03 稿](03-engine-kind.md) / [04 稿](04-contract-revision.md)；ADR-0021~0024

## 结论（一句话）

七条验收场景全部达成（D1/D2/D3 含两条一票否决），`profile.yaml` → engine + model + capability + policy 的真实进程闭环成立；实施期发现并修正一处"profile 全家桶下补偿必然升级"的权限读取缺口（P-022）。**具备打 `phase-4.end` 的条件（tag 与分支 merge 时机归所有者）**。

## 完成了什么（四片切片，全部真进程证据）

- **切片①合同与设计**：K1~K6 过闸；三份设计稿 + 修订清单定稿；四篇 ADR（统一流拓扑 / manifest 扩两 kind / `engine.step` 通道 / 表面事件族）；禁面扫描按 kind 分规则。
- **切片②Profile 装配面**：`profile.yaml` 严格子集解析 + 六步装配 + 逐插件装配记录；五 kind 各进各的隔离环境；未声明插件零加载；`keel validate/run --profile` 落地。
- **切片③`kind:"model"`**：模块只报三桶用量、费用由 Core 按 manifest 价格表（三桶 × 峰谷）计算；单次超预扣不把预算打成负数；非流式 120s / 流式断流 / 模块空闲看门狗三层治理；mock 进 CI、DeepSeek 适配器手动验证不进 CI。
- **切片④`kind:"engine"`**（本轮）：决策在 Cell、推进在 Core 的 ReAct 标杆；每步 `engine.step` 一往返，工具仍由 Core 一条链执行；表面事件投影重算上下文；kill 引擎舱的故障半径与补偿闭环；`keel run --profile` 接引擎驱动。

## 验收场景执行结果（D1~D7）

| 场景                                      | 结果 | 证据与一句话说明                                                                                                                                                                                                  |
| ----------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1【一票否决】Profile 装配与装配记录      | 通过 | `tests/profile-assembly-e2e.test.ts` D1-a~e（五 kind 隔离/逐插件记录/零加载/坏清单整份拒/跨 scope 互不可见/绝对路径拒）+ CLI 引擎闭环冒烟（4 插件全家桶）                                                         |
| D2【一票否决】模型调用计量与预算          | 通过 | `tests/model-kind-e2e.test.ts`（价格表峰谷、三桶、超支夹限、无未落账调用）+ `tests/engine-kind-e2e.test.ts` D2（引擎驱动的下一跳被 `BUDGET/EXHAUSTED` 拒、run 干净收束、`MODEL_INVOKED` 全有收尾）                |
| D3【一票否决】engine 真进程闭环与故障半径 | 通过 | `tests/engine-kind-e2e.test.ts` D3-a/b/c：模型→工具→模型→终结；file-write 真写盘 + 收据 + 补偿回放；kill 引擎舱 → `RUN_FAILED{ENGINE_EXITED}`、在途模型收束、并行 run 照常 halted                                 |
| D4 密钥红线                               | 通过 | 模型侧 D4（账本/装配记录/诊断零密钥值、缺失引用拒绝装配）+ engine 侧 D4（装配记录与账本零密钥值）；禁面扫描 `E5-key` 零命中；引擎舱不读进程环境（`E2-env` 零命中）                                                |
| D5 决策可重放含模型调用归因               | 通过 | `tests/engine-kind-e2e.test.ts` D5：每步 `DECISION.basedOn` 覆盖本步 `MODEL_USAGE` 与上一步 `TOOL_RESULT`，`throughSeq` 为上界；`projectSurface(账本)` 重算出同一消息序列；既有 `audit-attribution-replay` 零退化 |
| D6 流中途失败收束                         | 通过 | `tests/model-kind-e2e.test.ts` D6（上游抛/总时限/流中途抛/空闲看门狗：先结算再报错、`truncated` 与 `produced` 可对账）；引擎侧失败映射到既有错误码，不新增码                                                      |
| D7 质量与回归                             | 通过 | 六道门禁全绿（**64 文件 485 测试**）；Phase 1~3 承载测试零退化；新标杆零三方依赖（扫描器 B4 判定）；全量实扫 `clean`                                                                                              |

## 1. 本轮实施要点（切片④）

- **每步一往返**：Core 每轮把投影好的消息与工具清单发给引擎；引擎一步内调模型、返回"工具调用意图"或"终结摘要"；Core 校验、写表面事件、执行工具、结算、写账本。引擎没有工具执行入口，也没有账本入口。
- **表面事件只有 Core 写**：`TURN_INPUT` / `MODEL_MESSAGE` / `TOOL_RESULT` 是封闭白名单；模型视图是账本的纯函数投影，治理事件永不进入提示。
- **归因闭合**：模型调用事件（网关直写）由引擎驱动显式引用进 `DECISION.basedOn`；`throughSeq` 仍由账本盖章。
- **故障半径**：引擎舱在一步中间被杀 → `RUN_FAILED{ENGINE_EXITED}`；在途模型调用由网关结算；已落盘副作用保留收据、补偿可回放；并行 run 不受影响。
- **上限**：`maxSteps` 超限 → `RUN_HALTED{MAX_STEPS}`；一步时限取契约既有 300s 档；错误码零新增。

## 1.1 基准（B7，只测量不设阈值）

`keel bench` 同轮采集（2026-11-04，win32/x64，node v26.13.0）：**B7 模型调用治理全链**（授权 → 预扣 → `MODEL_INVOKED` → 桩上游 → `settle` → `MODEL_USAGE`）N=20，min/p50 = **0.2 / 0.2 ms**。与 B6 同族口径对比：治理满配的写工具全链约 1.2 ms，模型调用治理全链 0.2 ms——"每次调用都记账"的代价在本地通道上很小；上游网络延迟不在此口径内。

## 2. 实施期发现与处置

- **profile 全家桶下补偿必然升级（P-022）**：补偿执行器原只读**第一条**装配记录里的权限；profile 是逐插件一条，能力插件的 `fs.write.allow` 在后面的记录里 → `fs.remove` 被读成"无允许路径"并升级。已改为合并本 run 全部装配记录权限（cap+allow 去重），D3-b/c 的真写盘与补偿回放即回归证据。
- **同宿主多 profile 的模型名重绑（P-020 延伸）**：模型名在宿主进程内全局注册；两个装配若声明同一模型名，后装配者会换掉前者的上游实例。测试里用同一份 model 声明规避；文档口径仍是"一份 profile 内同名拒绝、跨装配显式重绑"。

## 3. 未验证 / 明确不承诺

- `model-deepseek` 真实请求：**2026-11-04 已手动验证**（密钥到位后补录，见 [02 稿 §11](02-model-kind.md)）——`deepseek-flash` 非流式与流式各一次成功，用量/峰谷档位/SSE 末块用量均与 manifest 价格表口径一致；仍**不进 CI**、不承诺生产可用。
- 跨 run 会话持久化、压缩、fork/resume、UI/桌面、多 Agent 编排：合同 §2 明确不做，留后续阶段/backlog。
- 真适配器的生产可用性：合同 K4 明确不承诺（mock 承载全部验收）。

## 4. 体量核对（standards/08）

- docs/：75 篇（软上限 150）；`.agents/`：34 个文件（handoff 滚动 5 份、pitfalls 22 条、CONTEXT ≤150 行）。
- 代码：新增 `engine-react` 源码 ~180 行、引擎驱动 ~360 行；单文件 >600 行：无。
- 依赖：仓库无新增三方运行时依赖；`engine-react` 零依赖（机械判定）。

## 5. 规范复查（standards/09 四问）

- 有漏洞吗：P-022（装配记录逐插件化后补偿权限只读第一条）是本轮唯一发现，已修并沉淀。
- 过严吗：无（禁面扫描零误报；engine 能力封闭未产生返工）。
- 过松吗：无。
- 冗余或矛盾吗：03 稿 E3 的"响应封闭"与新增 `message?` 字段已在实施注记里显式说明（只加字段、不改决策）。

## 6. 已知问题与风险

- 根 `tests/` 不在任何包 tsconfig 的 include 内（既有缺口）：本轮新增 e2e 由 vitest 转译执行，类型错误仍可能漏到运行期；登记为既有风险。
- `engine.step` 的 300s 一步时限在测试中未到点（到点语义由网关/通道既有用例覆盖）。
- 会话持久化与压缩留后续阶段；ADR-0021 的重评条件不变（账本 IO 成为瓶颈时重评 ADR-0004）。

## 7. 对下阶段的影响

- Phase 4 交付物齐备：Profile 装配面、model/engine 两个 kind、ReAct 标杆、`engine.step` 通道、表面事件族、扫描扩展、本报告。
- 待所有者决定：`phase-4.end` tag 与 `docs/phase4-charter` 分支 merge 时机。
- 后续候选（backlog 通道）：跨 run 会话、压缩、UI/桌面、多 Agent、`fs.restore`、容器隔离。

## 8. 文档更新清单

- 新增：本报告；`packages/plugins/engine-react/`（manifest + 实现 + REVIEW + 单测）。
- 修订：03 稿 §10 实施注记、04 稿切片④注记、看板 Phase 4 行、CHANGELOG（0.1.057）、`.agents/CONTEXT.md`、handoff H-036、pitfalls P-022。
