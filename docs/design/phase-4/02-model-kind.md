# Phase 4 切片①设计稿 02：`kind:"model"`（宿主驻留的模型插件）

- 状态：**定稿**（2026-11-04 起草 / 2026-11-04 所有者过闸——第二道闸通过，M3/M5 已确认）
- 日期：2026-11-04
- 关联：[phase-4 合同](../roadmap/phase-4-profile-engine-loop.md) §2/§5 D2/D4/D6/§6 B2~B4/§8 K4/K5；[契约 §4.7/§4.8/§7](../design/phase-1/01-core-api-contract.md)；[ADR-0003](../adr/ADR-0003-model-gateway.md)（网关唯一通道、预扣/实结）；[ADR-0013](../adr/ADR-0013-model-stream-pull-chunking.md)（拉式分片）；[ADR-0019](../adr/ADR-0019-trust-tiers-and-cell-isolation.md)（spawn env 白名单）；[ADR-0021](../adr/ADR-0021-session-ledger-topology.md)（表面事件与投影）；[research/02](../research/02-deepseek-api-survey.md)（DeepSeek API 现状：模型名/思考模式/usage/峰谷计价）

## 1. 本稿回答什么

模型插件**声明什么、跑在哪、密钥怎么到它手里、用量与费用谁说了算、超时与失败怎么收束**。不含：engine 循环（03 稿）、Profile 清单（01 稿）。

## 2. 事实对账

- **F1 上游接口只有两个方法**：`invoke(req) → {result, usage, cost}` 与可选 `stream?(req) → AsyncIterable<{chunk, cost, usage?}>`（`packages/core/src/gateway.ts:29-43`）。`usage` 是 `unknown` 透传（`events.ts:206-211`），**`cost` 是唯一驱动预算的数字**；全仓没有分词器。
- **F2 调用时序已定**：授权 → `budget.reserve(estimate)` → `MODEL_INVOKED` → 上游 → `budget.settle(cost)` → `MODEL_USAGE`（`gateway.ts:126-182`）；流式三 op 与四条终局（正常/断流/取消/上游抛）见 ADR-0013，每片不写事件。
- **F3 预扣不封顶实结**：`reserve` 检查 `used + estimate > limit` 即拒（`budget.ts:107-112`），但 `settle` 只校验 `actual` 为非负有限数（`budget.ts:132-159`）——**单次调用可以花超预扣，预算可能被一次失控调用穿透**。这是 K5 要补的口子。
- **F4 时限全取契约 §7 既有三档**：非流式 120s、流式首字节/取片等待 30s、流式总长 300s；网关只有测试注入位，没有运行期旋钮（`gateway.ts:100-124`）。
- **F5 Cell 侧无凭证、无出网**：`model.adapter` 编译出 `model.invoke` + `model.stream` 两条规则（`packages/host/src/permission-rules.ts:18-26`）；密钥相关实现今天**为零**（全仓无 `SecretResolver`），R5 只给了 spawn env 白名单与"不把宿主 env 全量递给子进程"的地基。
- **F6 上游今天是桩**：`apps/keel/src/runtime.ts:115-124`（`invoke` 恒 cost 0；`stream` 按参数造分片、每片 cost 1）。没有真实 provider 代码、没有 `packages/plugins/model-*`。
- **F7 事件面封闭**：`MODEL_INVOKED`（v2 含 `streamId`）、`MODEL_USAGE`（v2 含 `truncated`）已够用；新增字段按类型版本表处理（`events.ts:55-62`），**本稿不新增事件类型**。

## 3. 决策（M 编号；M3/M5 已确认，见 §9）

- **M1 运行位置与进程边界**：`kind:"model"` 是**宿主进程内的可信模块**（合同 K1：要持密钥）。它不 spawn Cell，不进入 Cell 沙箱；它的出网是职责本身，因此"禁止出网"的禁面只对 engine/capability 生效。装配器按 profile 的 `module` 路径 `import()`，校验导出面后交给网关。
- **M2 声明与实现分离**：manifest 的 `model` 段只写"这是什么上游、密钥引用名、价格表、时限"；实现代码在模块里。模块导出固定形状 `create({ model, secrets }) → ModelUpstream`（结构类型，不 import `@keel/*`，沿用插件零依赖纪律）。一个模块可服务多个模型名（`models` 列表）。
- **M3 计量与费用权威（已确认）**：**价格表进 manifest、费用由 Core 计算**。模块只返回 `usage`，按桶报数：`{inputCached, inputUncached, output, reasoning?}`（DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `completion_tokens` 直接映射，research/02 §6）。网关按 `Σ(bucket × 单价)/1e6` 算 `cost` 并结算；计价单位固定 **USD**（预算上限同单位）。价格**按模型分别声明**（同一插件可服务多个模型），并支持**峰谷两档**（`offPeak` / `peak` + 峰时窗口）——单桶单价会算错约 50 倍（缓存命中）或 2 倍（峰谷），这是 research/02 §9 的硬约束。峰谷判定用宿主时钟 + 窗口；**法定节假日不建模，落峰价（保守上界）**。为兼容既有 `ModelUpstream`，网关保留"上游给 cost"的老路径，但 `kind:"model"` 装配路径**拒绝**模块返回 `cost`（显式报错，不静默忽略）。`MODEL_USAGE` 载荷追加 `usageBuckets` / `pricedBy:"manifest"` / `tier`，类型版本升 3（按 ADR-0008 口径，旧账本可读）。
- **M4 流式复用 ADR-0013，零新增通道**：模块的 `stream?()` 返回上游分片；`model.stream.start/next/cancel` 不变；未实现 `stream` 的模块被请求流式 = `UPSTREAM_NO_STREAM` 显式失败，不降级（ADR-0013 决策 10）。**解析细节归模块**：工具调用增量按 `index` 拼块（首块带 id/name，后续只带 `arguments` 增量）、容忍 SSE `: keep-alive` 注释、usage 挂在最后一个内容块（无独立尾块）——这三条是 DeepSeek 的实测形状（research/02 §4/§5），mock 也要按同一形状产出，免得"mock 过了、真适配器不过"。
- **M5 超时与预算治理（已确认，K5）**：三层，全部复用契约既有数字，不造新旋钮：
  1. **总时限**（Core 强制）：非流式 120s、流式总长 300s——到点即按 ADR-0013 终局收束；
  2. **空闲看门狗**（模块内，可选声明 `idleTimeoutMs ≤ 总时限`）：按分片到达 rearm，触发即 abort 上游并走断流口径——补 DSH"只有 idle watchdog"的短板为"有总时限的 watchdog"；
  3. **单次调用费用上限**（Core 强制，补 F3）：`settle` 时 `actual > estimate` 的部分**不得把预算打到负数**——超出即记 `BUDGET_SETTLED{overrun:true}` 并把该 scope 置为耗尽（按既有 `onRunExhausted` 处置），同时 `MODEL_USAGE` 如实记真实用量（**不篡改计量**）。
- **M6 密钥路径（D4 的机制核心）**：manifest `auth.ref` = **环境变量名**（引用名，非明文）；Host 装配期只做 **presence-only** 检查（缺失即拒绝装配，错误只写 ref 名）；每次上游调用前 `resolve(ref)` 取当前值（**不缓存**、不写日志、不进账本/事件/诊断）；诊断只回 `{ref, present}`。mock 适配器用固定假密钥，守同一形状。
- **M7 两个实现，分工明确**：`packages/plugins/model-mock/`（确定性剧本：正常/分片/断流/超时/上游抛，进 CI 承载 D2/D6 全部断言）+ `packages/plugins/model-deepseek/`（直连 HTTP+SSE、零三方依赖、手动验证脚本、**不进 CI、不承诺生产可用**，K4）。选 DeepSeek 作第二实现：协议形状与现行模型名已沉淀在 [research/02](../research/02-deepseek-api-survey.md)（端点、SSE、工具增量、usage 三桶、限流），且不引入 SDK。
- **M8 禁面扩展（K6 的 model 半边）**：`kind:"model"` 的源码禁面——不得读 `process.env`（只能经 `create({secrets})` 注入的解析面）、不得把密钥写入 manifest/日志/事件、不得 import 治理面（网关/账本/授权）；扫描器按 kind 分规则集（03 稿与切片①收尾一并落）。
- **M9 provider 现实约束（照 research/02 落，不凭猜）**：
  1. **模型名**：示例与收益口径只用 `deepseek-flash` / `deepseek-v4-pro`；`deepseek-chat`/`deepseek-reasoner` 已停用（2026-07-24），只允许出现在"已停用"说明里；
  2. **思考模式默认开启**：适配器**不擅自注入** `thinking`/`reasoning_effort`（尊重 provider 默认，调用方可在 `params` 里显式关）；文档与手动验证记录必须写明这一点——"默认不思考"是错的假设；
  3. **`reasoning_content` 必须可回传**：带工具的请求漏传历史思考内容会 400，因此**表面消息形状必须携带该字段**（03 稿 E4 的投影与 04 稿 R1 的 `MODEL_MESSAGE` 载荷同步留字段）；
  4. **参数校验前置**：思考模式下 `tool_choice:"required"`/具名不被支持——适配器在发请求前拒绝（`GATEWAY/UPSTREAM-ERROR{reason:"TOOL_CHOICE_UNSUPPORTED"}`），不花一次请求的钱去换一个 400；
  5. **限流与重试**：429/500/503 是"可重试"语义，交给既有 hook③ 策略（`retryAdvice`）裁决；适配器只如实报 `detail.reason`（`RATE_LIMITED`/`SERVER_ERROR`/`OVERLOADED`），不自带退避算法（research/02 §8）。

## 4. manifest `model` 段（v1）

```json
{
  "kind": "model",
  "model": {
    "provider": "deepseek",
    "protocol": "http-sse",
    "models": ["deepseek-flash"],
    "endpoint": "https://api.deepseek.com",
    "auth": { "ref": "DEEPSEEK_API_KEY" },
    "pricing": {
      "deepseek-flash": {
        "unit": "usd_per_mtok",
        "offPeak": { "inputCached": 0.003, "inputUncached": 0.15, "output": 0.6 },
        "peak": { "inputCached": 0.006, "inputUncached": 0.3, "output": 1.2 },
        "peakWindows": [
          { "days": "mon-fri", "utc": "01:00-04:00" },
          { "days": "mon-fri", "utc": "06:00-10:00" }
        ],
        "unknownTier": "peak"
      }
    },
    "timeouts": { "idleMs": 30000 }
  }
}
```

| 字段                    | 必填                       | 约束                                                                                                               |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `provider`              | 是                         | kebab-case，仅用于诊断/记录                                                                                        |
| `protocol`              | 是                         | `"http-sse"` \| `"mock"`；未知值拒绝                                                                               |
| `models`                | 是                         | 非空，**provider 现行模型名**（示例 `deepseek-flash`；`deepseek-chat`/`deepseek-reasoner` 已停用，仅见于说明文字） |
| `endpoint`              | protocol=`http-sse` 时必填 | `https://`；本地回环测试允许 `http://127.0.0.1`；请求路径由协议决定（DeepSeek = `POST /chat/completions`）         |
| `auth.ref`              | 是                         | 环境变量名；**不得**出现 `sk-` 等明文形态（schema pattern + 扫描双保险）                                           |
| `pricing.<模型名>`      | 是                         | 键集合必须与 `models` 完全一致；`unit` 首版只 `usd_per_mtok`                                                       |
| `pricing.*.offPeak`     | 是                         | 三个桶 `inputCached`/`inputUncached`/`output`，非负有限数                                                          |
| `pricing.*.peak`        | 否                         | 缺省 = 峰价缺失时落 `unknownTier`（默认 `"peak"` 保守计费，不静默按谷价）                                          |
| `pricing.*.peakWindows` | 否                         | `days`（`mon-fri`）+ `utc:"HH:MM-HH:MM"`；有 `peak` 时必填；法定节假日不建模                                       |
| `timeouts.idleMs`       | 否                         | 正整数，≤ 契约 §7 对应总时限（装配器语义校验）                                                                     |

## 5. 装配与调用链（切片③落地形状）

1. profile 装配器读模块 → `create({model, secrets})` → 得到 `ModelUpstream` + 按模型的价格表；
2. `ModelGateway` 增加可选 `pricingByModel`（或 upstream 包装器）；每次调用按宿主时钟 + `peakWindows` 判峰谷（缺省保守落峰价），按桶计价；授权面不变（`model.adapter` 两规则）；
3. Cell 侧 engine 只认 `model.invoke`/`model.stream.*`，**永远看不到** provider、endpoint、密钥、价格；
4. 账本：`MODEL_INVOKED`（模型、reqId、请求摘要）→ `MODEL_USAGE`（`usageBuckets` 三桶、`tier`、`pricedBy:"manifest"`、cost、`truncated?`）；每步绑 `runId` 与步序（表面事件的时间线由 ADR-0021 定）。

## 6. 失败剧本（D6 的模型半边）

| 注入            | 期望                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 上游慢 / 不出片 | 总时限先到 → 断流终局：按已产出结算、`truncated:true`、失败上报语义按 ADR-0013 区分"慢"与"抛"                                     |
| 上游中途抛      | 已产出部分结算 + `truncated`，`GATEWAY/UPSTREAM-ERROR{reason:"STREAM_UPSTREAM_THROW", produced, cost}`                            |
| 一片都没出就断  | 失败（`STREAM_STALL`/`STREAM_DEADLINE`），仍先 settle 闭环                                                                        |
| 预扣后实结超高  | M5 第 3 条：账本如实、scope 置耗尽、下一跳被拒（D2 的机械断言）                                                                   |
| 429 / 500 / 503 | `GATEWAY/UPSTREAM-ERROR` + `detail.reason`（`RATE_LIMITED`/`SERVER_ERROR`/`OVERLOADED`）→ 由 hook③ `retryAdvice` 裁决；无自动退避 |
| 未实现 stream   | `UPSTREAM_NO_STREAM`，不降级                                                                                                      |

## 7. 验收映射与红测先行

| 场景          | 机械断言                                                                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2 计量与预算 | mock 剧本固定用量（hit/miss/output 三桶各不同）→ 账本 `MODEL_USAGE` 分桶与峰谷 `tier` 正确 → 预算注入超限 → 下一次调用 `BUDGET/EXHAUSTED` → `RUN_HALTED`，无未落账调用（遍历账本：每次 `MODEL_INVOKED` 必有对应 `MODEL_USAGE` 或 `BUDGET_SETTLED` 收束） |
| D4 密钥红线   | 扫描：manifest/账本/事件/日志/engine Cell env 中零密钥；真适配器路径只在 Host 模块内 resolve；mock 用 `sk-test-*` 假值也零泄漏                                                                                                                           |
| D6 流失败     | 四类注入各一条真进程/单测用例；`truncated` 与 `produced` 可对账                                                                                                                                                                                          |

红测先行：`packages/plugins/model-mock/test/*`（单测）+ `tests/model-kind-e2e.test.ts`（真进程，切片③开工时红→绿）。

## 8. 自检清单

- [ ] 没有新增事件类型；载荷追加都走类型版本表（`MODEL_USAGE` 升 3）
- [ ] `cost` 不再由被审方自报；按模型分价格表、三桶、峰谷两档；超出预扣不产生负预算（M5）
- [ ] 密钥只经 `auth.ref` + per-request resolve；presence-only；诊断 ref-only
- [ ] engine 侧对 provider/endpoint/密钥/价格零可见（只有模型名）
- [ ] 表面消息能携带 `reasoning_content`（M9 第 3 条），否则带工具的第二轮会 400
- [ ] 示例模型名是现行名（`deepseek-flash`），停用名不出现在可执行示例里
- [ ] 两个实现共用同一串验收断言；真适配器不进 CI 且文档写明不承诺生产
- [ ] manifest 的 `model` 段与 profile（01 稿 P2）分工不重叠

## 9. 确认记录

- **M3（2026-11-04）**：价格表进 manifest、模块只报用量、费用由 Core 计算并结算；`kind:"model"` 装配路径拒绝模块返回 `cost`。
- **M5（2026-11-04）**：三层治理照准——总时限（复用契约既有数字）+ 可选空闲看门狗（≤ 总时限）+ 单次超支不把预算打成负数（超出即记 `overrun` 并按既有耗尽处置，计量如实）。
- **整稿（2026-11-04）**：四份设计稿一批过闸，本稿按 M1~M9 定稿。

## 10. 实施注记（2026-11-04，切片③落地）

只补事实，不改决策：

1. **价格表接线**：`ModelGateway.registerModel({models, upstream, pricing})` 由 profile 装配器在 `create()` 校验通过后调用；有注册后，未注册模型名一律 `UPSTREAM_PROVIDED_COST`/`MODEL_NOT_REGISTERED` 式显式拒绝（`GATEWAY/UPSTREAM-ERROR.detail.reason`），不回落宿主演示桩。
2. **装配期唯一性**：一份 profile 内同名模型 = 整份拒绝（engine 只按名字调用）；跨装配（同宿主进程多次 `assembleProfile`）显式重绑该名字，见 [04 稿](04-contract-revision.md) 切片③注记。
3. **流式计价**：模块每片报**累计**三桶，网关在终局按最后一片计价；中间页不返回"半截金额"。模块带 `cost` 片 = 协议违规（按断流口径结算已产出部分后报错）。
4. **空闲看门狗**：`model.timeouts.idleMs` 由模块在两次取片之间 rearm；mock 用 `pauseAfterFirstMs` 剧本复现，e2e 断言 `produced/cost/truncated` 可对账。
5. **两个实现**：`packages/plugins/model-mock`（CI）+ `packages/plugins/model-deepseek`（手动脚本，未执行真实请求）；扫描零命中，REVIEW 留痕在各插件目录。
6. **证据**：`tests/model-kind-e2e.test.ts` 12 例（D2/D4/D6）+ 包内单测（6 例）+ `packages/core/test/{pricing,gateway-priced,budget}.test.ts`；六道门禁见阶段看板。
