# H-036 切片③ model kind 落地

- 日期：2026-11-04
- 主题：Phase 4 切片③——`kind:"model"` 端到端（锚 D2/D4/D6）

## 本轮做了什么

1. **契约修订 R1/R3/R4/R5 落地**（R2/R9~R13 上片已完成）
   - `events.ts`：新增 `TURN_INPUT` / `MODEL_MESSAGE`；`SURFACE_EVENT_TYPES` 白名单（含 `TOOL_RESULT`）
     - `isSurfaceEventType`；`surfaceOp` 形状预留（不实现）。`MODEL_USAGE` 升 v3
       （`usageBuckets`/`tier`/`pricedBy`）、`BUDGET_SETTLED` 升 v2（`overrun`）。
   - `surface.ts`：Core 侧 `appendTurnInput` / `appendModelMessage`（Cell 仍无账本写通道）。
2. **计价与治理**
   - `pricing.ts`：三桶 × 峰谷（UTC 窗口 + 星期，跨零点支持，缺省保守落峰价）；
     `readUsageBuckets` 缺失/负数/非有限即拒（不按 0 记账）。
   - `gateway.ts`：`registerModel({models, upstream, pricing}, {replace?})`；未注册模型名拒绝；
     模块自报 cost → `UPSTREAM_PROVIDED_COST`；非流式 120s（`invokeTimeoutMs` 测试缝）；
     流式终局按累计三桶计价、中间页不给半截金额；模块 reason 透传到 `detail.reason`。
   - `budget.ts`：`settle` 超预扣时夹到限额 + `overrun:true`（计量如实），并用 1e-12 收浮点噪声。
   - `profile/assemble.ts`：model `create()` 成功后逐模型名注册网关；一份 profile 内同名模型整份拒绝。
3. **两个 model 插件**
   - `packages/plugins/model-mock`：进 CI。剧本 `ok`/`throw`/`slow`/`no-usage`/`chunksBeforeThrow`/
     `pauseAfterFirstMs`；每片累计三桶；模块内空闲看门狗（`idleMs`）。
   - `packages/plugins/model-deepseek`：HTTP+SSE、零依赖（内建 fetch）、手动脚本
     `scripts/verify-model-deepseek.mjs`；**本轮无密钥，未执行真实请求**。
   - 两个目录各有 `REVIEW.md`；`packages/plugins/README.md` 已补 model 段。
4. **文档回填**：契约 §4.7/§5（切片③注记 + 事件表两行）；02 稿 §10 实施注记；04 稿切片③注记；
   roadmap 看板与顶部"最近更新"；CHANGELOG 0.1.056。
5. **测试**：`packages/core/test/pricing.test.ts`（4）、`gateway-priced.test.ts`（5）、
   `budget.test.ts` +1、`model-mock/test`（6）、`tests/model-kind-e2e.test.ts`（12）。

## 验证

- 六道门禁：format / lint / typecheck+build / test **62 文件 470 测试** / 禁面扫描零命中。
- D2：峰 1.4 / 谷 0.7 可复算；超预扣 → `used = limit`、`remaining = 0`、下一跳 `BUDGET/EXHAUSTED`；
  每条 `MODEL_INVOKED` 都有 `MODEL_USAGE` 或 `BUDGET_SETTLED` 收束。
- D4：账本段文件、装配记录、事件、错误诊断零密钥值；缺密钥时错误只写 ref 名。
- D6：上游抛 / 120s 到点 / 用量不按桶报都先 settle 再报错；流中途抛与看门狗都 `truncated:true`
  且 `produced/cost` 可对账；流式分片不写事件。
- 回归：`profile-assembly-e2e`（D1-a~e）与全仓既有测试保持绿；修了一处"同一宿主重复装配同名模型"
  的闸（见 P-020）。

## 遗留与下一步

1. **切片④ engine kind**（R6~R8）：`engine.step` 通道、ReAct 标杆、D3 真进程 + kill 故障半径、
   含 engine 的 `keel run --profile`、阶段报告收口。切片③留的接缝：表面投影函数（E4）在切片④
   按 `SURFACE_EVENT_TYPES` 实现；engine Cell 的模型调用直接走已注册网关。
2. `model-deepseek` 的真实请求未验证（K4 明示），需要所有者提供密钥后跑手动脚本。
3. `keel run --profile` 对 model-only profile 仍用 demo driver（引擎驱动归切片④）；CLI 未新增参数。
4. `phase-4.end` tag 与分支 merge 时机归所有者。

## 已提取沉淀

- P-020（模型按名注册：跨装配重绑 ≠ 重复注册）。
- P-021（金额浮点求和噪声：夹限额前的账要对齐）。
