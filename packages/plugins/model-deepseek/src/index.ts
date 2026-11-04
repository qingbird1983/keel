/**
 * `model-deepseek` —— `kind:"model"` 的第二实现（Phase 4 切片③，02 稿 M7/M9 / K4）。
 *
 * 定位：直连 HTTP + SSE、零三方依赖、**手动验证、不进 CI、不承诺生产可用**。
 * 它证明抽象不是为 mock 量身定做；验收断言仍由 `model-mock` 承载。
 *
 * 事实口径（[research/02](../../../../docs/research/02-deepseek-api-survey.md)）：
 * - 现行模型名 = `deepseek-flash` / `deepseek-v4-pro`；`deepseek-chat`/`deepseek-reasoner` 已停用；
 * - 思考模式默认开启：适配器**不擅自注入** `thinking`/`reasoning_effort`；
 * - `reasoning_content` 必须随历史消息回传，带工具的请求漏传会 400；
 * - 用量三桶 = `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `completion_tokens`；
 * - 429/500/503 = 可重试语义，适配器只如实报 `reason`，不自带退避算法（交给 hook③）。
 *
 * 密钥只经 `create({ secrets })` 注入面 per-request resolve；不读进程环境、不写日志。
 */

export interface DeepseekModelSection {
  provider: string;
  protocol: "mock" | "http-sse";
  models: string[];
  endpoint?: string;
  auth: { ref: string };
  timeouts?: { idleMs?: number };
}

export interface CreateInput {
  model: DeepseekModelSection;
  secrets: { resolve(ref: string): string | undefined };
}

/** 适配器抛出的可归因错误（网关会把 `reason` 透传到 `GATEWAY/UPSTREAM-ERROR.detail.reason`）。 */
export interface UpstreamError extends Error {
  reason: string;
}

function failure(reason: string, message: string): UpstreamError {
  const err = new Error(message) as UpstreamError;
  err.reason = reason;
  return err;
}

interface RawUsage {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens?: number;
}

interface RawMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: unknown;
}

interface RawChoice {
  message?: RawMessage;
  delta?: RawMessage;
  finish_reason?: string | null;
}

interface RawChunk {
  choices?: RawChoice[];
  usage?: RawUsage | null;
}

function bucketsOf(usage: RawUsage | null | undefined) {
  if (!usage) return undefined;
  return {
    inputCached: usage.prompt_cache_hit_tokens ?? 0,
    inputUncached: usage.prompt_cache_miss_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
  };
}

/** `tool_choice` 在思考模式下不被支持：发请求前拒绝，不花一次请求去换一个 400。 */
function assertToolChoice(params: Record<string, unknown>): void {
  const choice = params.tool_choice;
  const thinkingOff =
    typeof params.thinking === "object" &&
    params.thinking !== null &&
    (params.thinking as { type?: string }).type === "disabled";
  if (!thinkingOff && choice !== undefined && choice !== "auto" && choice !== "none") {
    throw failure("TOOL_CHOICE_UNSUPPORTED", "tool_choice is unsupported while thinking is on");
  }
}

function reasonForStatus(status: number): string {
  if (status === 429) return "RATE_LIMITED";
  if (status === 500) return "SERVER_ERROR";
  if (status === 503) return "OVERLOADED";
  return "UPSTREAM_ERROR";
}

async function post(url: string, key: string, body: unknown, signal: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    // 不把响应体原样带出（可能含限额/账户细节）：状态 + 稳定 reason 足够归因
    throw failure(reasonForStatus(res.status), `deepseek upstream returned ${res.status}`);
  }
  return res;
}

/** 逐行拆 SSE；`: keep-alive` 注释与空行直接丢，`data:` 才交付。 */
async function* sseData(body: ReadableStream<Uint8Array>, idleMs?: number) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readOnce = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (idleMs === undefined) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(failure("STREAM_STALL", `deepseek sent no data within ${idleMs}ms`)),
        Math.max(1, idleMs),
      );
      timer.unref?.();
    });
    return Promise.race([reader.read(), idle]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  try {
    for (;;) {
      const { done, value } = await readOnce();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
        idx = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

export function create({ model, secrets }: CreateInput) {
  const endpoint = (model.endpoint ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const url = `${endpoint}/chat/completions`;

  const keyOf = (): string => {
    const key = secrets.resolve(model.auth.ref);
    if (key === undefined || key === "") {
      throw failure("SECRET_MISSING", "api key reference resolved to nothing");
    }
    return key;
  };

  return {
    async invoke(req: { model: string; params: unknown }) {
      const params = (req.params ?? {}) as Record<string, unknown>;
      assertToolChoice(params);
      const key = keyOf();
      const res = await post(
        url,
        key,
        { ...params, model: req.model, stream: false },
        AbortSignal.timeout(model.timeouts?.idleMs ?? 120_000),
      );
      const data = (await res.json()) as RawChunk;
      const message = data.choices?.[0]?.message ?? {};
      return {
        result: {
          role: "assistant",
          content: message.content ?? "",
          ...(message.reasoning_content ? { reasoningContent: message.reasoning_content } : {}),
          ...(message.tool_calls ? { toolCalls: message.tool_calls } : {}),
        },
        usage: bucketsOf(data.usage),
      };
    },

    async *stream(req: { model: string; params: unknown }) {
      const params = (req.params ?? {}) as Record<string, unknown>;
      assertToolChoice(params);
      const key = keyOf();
      const controller = new AbortController();
      const res = await post(
        url,
        key,
        { ...params, model: req.model, stream: true },
        controller.signal,
      );
      if (!res.body) throw failure("STREAM_NO_BODY", "deepseek response has no body");
      try {
        for await (const data of sseData(res.body, model.timeouts?.idleMs)) {
          if (data === "[DONE]") return;
          const parsed = JSON.parse(data) as RawChunk;
          const choice = parsed.choices?.[0];
          const delta = choice?.delta ?? {};
          const piece: Record<string, unknown> = {};
          if (typeof delta.content === "string" && delta.content !== "") {
            piece.content = delta.content;
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
            piece.reasoningContent = delta.reasoning_content;
          }
          if (delta.tool_calls !== undefined) piece.toolCalls = delta.tool_calls;
          if (choice?.finish_reason) piece.finishReason = choice.finish_reason;
          // 用量按 research/02 §4 的形状挂在最后一个内容块；无内容但有用量时也交出去
          const usage = bucketsOf(parsed.usage);
          yield usage ? { chunk: piece, usage } : { chunk: piece };
        }
      } finally {
        controller.abort(); // 消费方提前收摊时释放连接
      }
    },
  };
}
