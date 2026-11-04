# Research 02：DeepSeek API 现状（模型名、思考模式、用量与计价）

- 状态：冻结（官方来源事实；检索日 2026-10-31，来源 URL 逐条标注）
- 日期：2026-11-04（沉淀自所有者提供的调研笔记，用于 Phase 4 `kind:"model"` 设计）
- 来源：官方文档 <https://api-docs.deepseek.com/>（create-chat-completion / guides/thinking_mode / guides/tool_calls / guides/kv_cache / quick_start/pricing / quick_start/rate_limit / quick_start/error_codes / updates）
- 用途：Phase 4 真适配器（`packages/plugins/model-deepseek`）与计价设计的**事实侧**；决策仍归设计稿。凡本文件标"未确认"的条目，实施时不得凭猜测落代码。

## 1. 模型名（最易踩的坑）

- **现行模型名只有两个**：`deepseek-flash`（底层 V4.1-Flash-1017）与 `deepseek-v4-pro`（V4-Pro-0813）。（pricing 页、create-chat-completion 的 `model` enum）
- **`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用**（2026-04-24 公告"三个月后停用"）。（updates）
- 兼容别名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍被接受，但实际由 V4.1-Flash 服务并按 Flash 计价。（pricing 脚注）
- 上下文 1M；最大输出 384K（393216）。（pricing）

## 2. 端点与鉴权

- OpenAI 兼容：`POST https://api.deepseek.com/chat/completions`；Anthropic 兼容：`https://api.deepseek.com/anthropic`；Beta（strict 工具、prefix completion）：`https://api.deepseek.com/beta`。（create-chat-completion / tool_calls / pricing）
- 鉴权 `Authorization: Bearer <API_KEY>`；另有 `GET /models`。（create-chat-completion / list-models）

## 3. 思考模式（默认开启）

- 两个现行模型**默认开启思考**（effort 默认 `high`）；关闭需 `thinking:{"type":"disabled"}` 或 `reasoning_effort:"none"`；`thinking` 优先于 `reasoning_effort`。（thinking_mode / create-chat-completion）
- 思考内容在 `choices[0].message.reasoning_content`（流式为 `delta.reasoning_content`），与 `content` 同级。（thinking_mode）
- **带 `tools` 时必须把历史轮次的 `reasoning_content` 原样回传**（含未调用工具的轮次），否则 400。（thinking_mode）
- 思考模式忽略 `temperature`；`presence_penalty`/`frequency_penalty` 已废弃。（create-chat-completion / thinking_mode）

## 4. 工具调用

- 形状与 OpenAI function tool 一致；响应 `choices[0].message.tool_calls[] = {id, type:"function", function:{name, arguments}}`，`arguments` 是 JSON **字符串**，需自行校验（官方提醒可能非法 JSON/幻觉参数）。（create-chat-completion / tool_calls）
- `tool_choice`：`none` / `auto` / `required` / 具名；**思考模式下 `required` 与具名返回 400**。（create-chat-completion）
- 流式工具调用：`delta.tool_calls[]` 按 `index` 拼块——首块带 `index/id/type/function(含 name)`，后续块只带 `function.arguments` 增量。（create-chat-completion）
- 函数名限 `a-zA-Z0-9_-`，≤128 字符。（create-chat-completion）
- **未确认**：并行工具调用是否官方保证（schema 无 `parallel_tool_calls`，文档无 "parallel" 字样）。

## 5. 流式（SSE）

- `stream:true` → `data: {...}` 块（`chat.completion.chunk`）+ 结尾 `data: [DONE]`；等待期有 SSE 注释 `: keep-alive`，解析器必须容忍。（create-chat-completion / rate_limit）
- `stream_options:{"include_usage":true}` 必须与 `stream:true` 同用；**没有独立 usage-only 尾块**——usage 挂在最后一个内容块（`finish_reason` 非空）上；其余块 `usage` 为 `null`。（create-chat-completion）
- 推理 10 分钟未开始，服务端断连。（rate_limit）

## 6. usage 与缓存

- required：`prompt_tokens`、`prompt_tokens_details`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`completion_tokens`、`total_tokens`；optional：`completion_tokens_details.reasoning_tokens`。（create-chat-completion）
- `prompt_tokens = hit + miss`；`prompt_tokens_details.cached_tokens` 与 `prompt_cache_hit_tokens` 同值。（同上）
- 磁盘前缀缓存默认开启、best-effort、不保证命中率；命中要求完全前缀匹配。（kv_cache）

## 7. 计价（USD / 1M token）

- 峰时 = 工作日（周一~周五）UTC 01:00–04:00 与 06:00–10:00（中国法定节假日除外）；其余为谷时，谷价 = 峰价一半。（pricing 脚注 2）

| 项目 | deepseek-flash 谷 / 峰 | deepseek-v4-pro 谷 / 峰 |
| --- | --- | --- |
| 输入·缓存命中 | 0.003 / 0.006 | 0.022 / 0.044 |
| 输入·缓存未命中 | 0.15 / 0.30 | 0.66 / 1.32 |
| 输出 | 0.60 / 1.20 | 1.98 / 3.96 |

- 成本 = `hit × 命中价 + miss × 未命中价 + output × 输出价`；思考 token 计入输出（计价口径**未逐字确认**，按 usage 结构推断）。（pricing / kv_cache / create-chat-completion）

## 8. 错误与限流

- 400 Invalid Format / 401 Authentication / 402 Insufficient Balance / 422 Invalid Parameters / 429 Rate Limit / 500 Server Error / 503 Overloaded。（error_codes）
- 限流按**账号级并发数**：`deepseek-flash` 2500、`deepseek-v4-pro` 500；超限 429；可申请扩容。（rate_limit / pricing）
- 重试：500/503 "retry after a brief wait"；429 "pace your requests"；官方无退避算法。（error_codes）
- 官方文档明载的 400 场景：`stream_options` 未配 `stream:true`；思考模式用 `tool_choice:"required"`/具名；带 tools 漏传历史 `reasoning_content`。（create-chat-completion / thinking_mode）
- **未确认**：错误响应 JSON 体的确切字段；QPS/TPM 维度限流。

## 9. 对 Keel 设计的硬约束（事实推论，非决策）

1. `models` 示例必须是 `deepseek-flash` / `deepseek-v4-pro`；`deepseek-chat` 只能出现在"已停用"的说明里。
2. 计价分桶至少三类：`inputCached` / `inputUncached` / `output`（可加 `reasoning` 归入 output），且需峰谷两档价——单桶单价的计价模型会算错约 50 倍（缓存命中）与 2 倍（峰谷）。
3. 表面消息必须能携带 `reasoning_content`，否则带工具的第二轮起直接 400——投影与事件词汇都要留这个字段。
4. 流式解析要处理：按 `index` 拼工具调用增量、容忍 keep-alive 注释、usage 挂在末块。
5. 思考模式默认开启：提示词/参数里不要假设"非思考"的默认值；`max_tokens` 缺省 8K（非思考）/64K（思考）。
