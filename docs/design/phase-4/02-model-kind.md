# Phase 4 切片①设计稿 02：`kind:"model"`（宿主驻留的模型插件）

- 状态：**草稿**（待所有者评审——第二道闸；过闸后转定稿方可开工切片③）
- 日期：2026-11-04
- 关联：[phase-4 合同](../roadmap/phase-4-profile-engine-loop.md) §2/§5 D2/D4/D6/§6 B2~B4/§8 K4/K5；[契约 §4.7/§4.8/§7](../design/phase-1/01-core-api-contract.md)；[ADR-0003](../adr/ADR-0003-model-gateway.md)（网关唯一通道、预扣/实结）；[ADR-0013](../adr/ADR-0013-model-stream-pull-chunking.md)（拉式分片）；[ADR-0019](../adr/ADR-0019-trust-tiers-and-cell-isolation.md)（spawn env 白名单）；[ADR-0021](../adr/ADR-0021-session-ledger-topology.md)（表面事件与投影）

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

## 3. 决策（M 编号；M3/M5 待所有者拍板）

- **M1 运行位置与进程边界**：`kind:"model"` 是**宿主进程内的可信模块**（合同 K1：要持密钥）。它不 spawn Cell，不进入 Cell 沙箱；它的出网是职责本身，因此"禁止出网"的禁面只对 engine/capability 生效。装配器按 profile 的 `module` 路径 `import()`，校验导出面后交给网关。
- **M2 声明与实现分离**：manifest 的 `model` 段只写"这是什么上游、密钥引用名、价格表、时限"；实现代码在模块里。模块导出固定形状 `create({ model, secrets }) → ModelUpstream`（结构类型，不 import `@keel/*`，沿用插件零依赖纪律）。一个模块可服务多个模型名（`models` 列表）。
- **M3 计量与费用权威（待拍板）**：建议**价格表进 manifest、费用由 Core 计算**：manifest 声明 `pricing:{unit, input, output}`，模块只返回 `usage:{input, output}`（可加 `cached`/`reasoning` 等可选桶），网关按 `Σ(bucket × price)` 算 `cost` 并结算。理由：`cost` 由被审方自报 = 预算权威旁落（F1/F3），而模型插件是可信但不是"治理者"。为兼容既有 `ModelUpstream`，网关保留"上游给 cost"的老路径，但 `kind:"model"` 装配路径**拒绝**模块返回 `cost`（显式报错，不静默忽略）。`MODEL_USAGE` 载荷追加可选 `usageBuckets`/`pricedBy:"manifest"`，类型版本升 3（按 ADR-0008 口径，旧账本可读）。
- **M4 流式复用 ADR-0013，零新增通道**：模块的 `stream?()` 返回上游分片；`model.stream.start/next/cancel` 不变；未实现 `stream` 的模块被请求流式 = `UPSTREAM_NO_STREAM` 显式失败，不降级（ADR-0013 决策 10）。
- **M5 超时与预算治理（待拍板，K5）**：建议三层，全部复用契约既有数字，不造新旋钮：
  1. **总时限**（Core 强制）：非流式 120s、流式总长 300s——到点即按 ADR-0013 终局收束；
  2. **空闲看门狗**（模块内，可选声明 `idleTimeoutMs ≤ 总时限`）：按分片到达 rearm，触发即 abort 上游并走断流口径——补 DSH"只有 idle watchdog"的短板为"有总时限的 watchdog"；
  3. **单次调用费用上限**（Core 强制，补 F3）：`settle` 时 `actual > estimate` 的部分**不得把预算打到负数**——超出即记 `BUDGET_SETTLED{overrun:true}` 并把该 scope 置为耗尽（按既有 `onRunExhausted` 处置），同时 `MODEL_USAGE` 如实记真实用量（**不篡改计量**）。
- **M6 密钥路径（D4 的机制核心）**：manifest `auth.ref` = **环境变量名**（引用名，非明文）；Host 装配期只做 **presence-only** 检查（缺失即拒绝装配，错误只写 ref 名）；每次上游调用前 `resolve(ref)` 取当前值（**不缓存**、不写日志、不进账本/事件/诊断）；诊断只回 `{ref, present}`。mock 适配器用固定假密钥，守同一形状。
- **M7 两个实现，分工明确**：`packages/plugins/model-mock/`（确定性剧本：正常/分片/断流/超时/上游抛，进 CI 承载 D2/D6 全部断言）+ `packages/plugins/model-deepseek/`（直连 HTTP+SSE、零三方依赖、手动验证脚本、**不进 CI、不承诺生产可用**，K4）。选 DeepSeek 作第二实现：仓库与该 provider 的协议形状已有参照（research/01 §3），且不引入 SDK。
- **M8 禁面扩展（K6 的 model 半边）**：`kind:"model"` 的源码禁面——不得读 `process.env`（只能经 `create({secrets})` 注入的解析面）、不得把密钥写入 manifest/日志/事件、不得 import 治理面（网关/账本/授权）；扫描器按 kind 分规则集（03 稿与切片①收尾一并落）。

## 4. manifest `model` 段（v1）

```json
{
  "kind": "model",
  "model": {
    "provider": "deepseek",
    "protocol": "http-sse",
    "models": ["deepseek-chat"],
    "endpoint": "https://api.deepseek.com",
    "auth": { "ref": "DEEPSEEK_API_KEY" },
    "pricing": { "unit": "token", "input": 0.0000005, "output": 0.0000015 },
    "timeouts": { "idleMs": 30000 }
  }
}
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `provider` | 是 | kebab-case，仅用于诊断/记录 |
| `protocol` | 是 | `"http-sse"` \| `"mock"`；未知值拒绝 |
| `models` | 是 | 非空，模型名列表（`model.invoke` 的 `model` 必须命中） |
| `endpoint` | protocol=`http-sse` 时必填 | `https://`；本地回环测试允许 `http://127.0.0.1` |
| `auth.ref` | 是 | 环境变量名；**不得**出现 `sk-` 等明文形态（schema pattern + 扫描双保险） |
| `pricing` | 是（M3 通过后） | 非负有限数；`unit` 首版只 `token` |
| `timeouts.idleMs` | 否 | 正整数，≤ 契约 §7 对应总时限（装配器语义校验） |

## 5. 装配与调用链（切片③落地形状）

1. profile 装配器读模块 → `create({model, secrets})` → 得到 `ModelUpstream` + 价格表；
2. `ModelGateway` 增加可选 `pricingByModel`（或 upstream 包装器）；授权面不变（`model.adapter` 两规则）；
3. Cell 侧 engine 只认 `model.invoke`/`model.stream.*`，**永远看不到** provider、endpoint、密钥、价格；
4. 账本：`MODEL_INVOKED`（模型、reqId、请求摘要）→ `MODEL_USAGE`（用量分桶、cost、`truncated?`）；每步绑 `runId` 与步序（表面事件的时间线由 ADR-0021 定）。

## 6. 失败剧本（D6 的模型半边）

| 注入 | 期望 |
| --- | --- |
| 上游慢 / 不出片 | 总时限先到 → 断流终局：按已产出结算、`truncated:true`、失败上报语义按 ADR-0013 区分"慢"与"抛" |
| 上游中途抛 | 已产出部分结算 + `truncated`，`GATEWAY/UPSTREAM-ERROR{reason:"STREAM_UPSTREAM_THROW", produced, cost}` |
| 一片都没出就断 | 失败（`STREAM_STALL`/`STREAM_DEADLINE`），仍先 settle 闭环 |
| 预扣后实结超高 | M5 第 3 条：账本如实、scope 置耗尽、下一跳被拒（D2 的机械断言） |
| 未实现 stream | `UPSTREAM_NO_STREAM`，不降级 |

## 7. 验收映射与红测先行

| 场景 | 机械断言 |
| --- | --- |
| D2 计量与预算 | mock 剧本固定用量 → 账本 `MODEL_USAGE` 分桶正确 → 预算注入超限 → 下一次调用 `AUTH`? 不，`BUDGET/EXHAUSTED` → `RUN_HALTED`，无未落账调用（遍历账本：每次 `MODEL_INVOKED` 必有对应 `MODEL_USAGE` 或 `BUDGET_SETTLED` 收束） |
| D4 密钥红线 | 扫描：manifest/账本/事件/日志/engine Cell env 中零密钥；真适配器路径只在 Host 模块内 resolve；mock 用 `sk-test-*` 假值也零泄漏 |
| D6 流失败 | 四类注入各一条真进程/单测用例；`truncated` 与 `produced` 可对账 |

红测先行：`packages/plugins/model-mock/test/*`（单测）+ `tests/model-kind-e2e.test.ts`（真进程，切片③开工时红→绿）。

## 8. 自检清单

- [ ] 没有新增事件类型；载荷追加都走类型版本表（M3 若通过，`MODEL_USAGE` 升 3）
- [ ] `cost` 不再由被审方自报（M3 通过后）；超出预扣不产生负预算（M5）
- [ ] 密钥只经 `auth.ref` + per-request resolve；presence-only；诊断 ref-only
- [ ] engine 侧对 provider/endpoint/密钥/价格零可见（只有模型名）
- [ ] 两个实现共用同一串验收断言；真适配器不进 CI 且文档写明不承诺生产
- [ ] manifest 的 `model` 段与 profile（01 稿 P2）分工不重叠

## 9. 确认记录与待拍板

- **M3 已确认（2026-11-04）**：价格表进 manifest、模块只报用量、费用由 Core 计算并结算；`kind:"model"` 装配路径拒绝模块返回 `cost`。
- **M5 已确认（2026-11-04）**：三层治理照准——总时限（复用契约既有数字）+ 可选空闲看门狗（≤ 总时限）+ 单次超支不把预算打成负数（超出即记 `overrun` 并按既有耗尽处置，计量如实）。
