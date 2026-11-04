# 插件 `model-deepseek` 评审留痕（Phase 4 切片③，2026-11-04）

> 定位（02 稿 M7 / 合同 K4）：**第二实现**——直连 HTTP+SSE、零三方依赖、手动验证、
> **不进 CI、不承诺生产可用**。它证明抽象不是为 mock 量身定做；验收断言仍由 `model-mock` 承载。

## ① manifest 摘录

- **能力**：无（model 分支强制为空）。
- **资源**：`{}`；时限只有 `model.timeouts.idleMs = 30000`（≤ 契约总时限 300s）。
- **补偿**：`templates: []`。
- **密钥**：`auth.ref = DEEPSEEK_API_KEY`（环境变量名）；装配期 presence-only，模块 per-request
  `secrets.resolve(ref)`，不缓存、不写日志、不进账本。
- **价格表**：按现行模型名分别声明（`deepseek-flash` / `deepseek-v4-pro`），三桶 + 峰谷两档 +
  两条 UTC 峰时窗口；`unknownTier:"peak"` 保守计费。数字来源
  [research/02](../../../docs/research/02-deepseek-api-survey.md) §7（2026-11-04 检索）。
- **已停用名**：`deepseek-chat` / `deepseek-reasoner` 只允许出现在说明文字里，示例与可执行面不用。

## ② 禁面（K6 / 04 稿 §4）

| 规则      | 判定   | 证据                                                             |
| --------- | ------ | ---------------------------------------------------------------- |
| E2-env    | 零命中 | 不读进程环境；密钥经 `create({secrets})` 注入                    |
| E5-key    | 零命中 | 源码无密钥形态字面量；`authorization` 头只由 resolver 返回值拼装 |
| M1-cost   | 零命中 | 只报三桶用量；不返回费用字段（费用权威在 Core）                  |
| E1-net    | 不适用 | 该规则只对 engine 生效；model 的出网是职责本身                   |
| B4-deps   | 零命中 | `package.json` 无依赖（用 Node 内建 `fetch`）                    |
| B4-import | 零命中 | 无 import（全部用内建全局）                                      |

## ③ 看代码三件事

- **入口形状**：`create({ model, secrets })` → `{ invoke, stream }`；结构类型，不 import `@keel/*`。
- **协议事实**：`POST /chat/completions`；思考模式默认开启 → 适配器不注入 `thinking`/`reasoning_effort`；
  `tool_choice:"required"`/具名在思考模式下**发请求前拒绝**（`TOOL_CHOICE_UNSUPPORTED`，不花一次请求换 400）；
  `reasoning_content` 随回答结果回传；三桶映射 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `completion_tokens`。
- **流式**：SSE 逐行解析，忽略 `: keep-alive` 注释；用量挂在末块；`[DONE]` 收束；空闲看门狗到点中止。
  429/500/503 只报稳定 `reason`（`RATE_LIMITED`/`SERVER_ERROR`/`OVERLOADED`），不自带退避算法（归 hook③）。

## ④ 验证状态

- **未进 CI**（合同 K4）。手动脚本：[`scripts/verify-model-deepseek.mjs`](../../../scripts/verify-model-deepseek.mjs)
  （`DEEPSEEK_API_KEY=... node scripts/verify-model-deepseek.mjs [模型名]`，先 `pnpm build`）。
- **未执行**：本次切片没有可用密钥，脚本只做过编译与静态检查；**没有**真实请求记录。
  这一条按 K4 明示：真适配器不承诺生产可用，验收断言由 mock 承载。
- 禁面扫描：`native-plugin-scan: clean`。

## ⑤ 不可观察面

- 真实限流、账户余额、错误响应 JSON 字段形状未逐字确认（research/02 §8 已标注"未确认"）；
  适配器按状态码映射稳定 reason，不解析错误正文。
- 计价的"思考 token 计入 output"是 research/02 §7 的结构推断，未逐字确认。
