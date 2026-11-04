/**
 * `engine-react` —— `kind:"engine"` 的最小 ReAct 标杆（Phase 4 切片④，03 稿 §4/E1~E5）。
 *
 * 定位：**决策在 Cell、推进在 Core**。本模块每被 `engine.step` 问一次，就做一件事：
 * 把 Core 投影好的消息与工具清单转成模型请求 → 调一次模型 → 把"工具调用意图"或"终结摘要"
 * 连同模型回答正文一起交回。它**没有**工具执行入口、没有账本入口、不读进程环境、不出网。
 *
 * 模型调用走 Cell 的 `client.modelInvoke`（网关唯一通道）：授权、预扣、计量、结算都在 Core。
 * 本模块看不到 provider / endpoint / 密钥 / 价格，只持有报关单里的模型名。
 *
 * 请求估算：引擎没有价格表，给一个保守的每步预扣单位；实际金额以 Core 的实结为准
 * （超预扣由 Core 按既有 overrun 语义收束）。
 */

export interface EngineDeclView {
  loop: "react";
  model: { ref: string; name: string };
  tools: string[];
  maxSteps: number;
}

export interface SurfaceMessageView {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: { id?: string; name: string; arguments: unknown }[];
  toolCallId?: string;
}

export interface EngineStepInputView {
  runId: string;
  step: number;
  maxSteps: number;
  messages: SurfaceMessageView[];
  tools: { name: string; schemaVersion: number; schema: unknown }[];
  lastResult?: {
    tool: string;
    toolCallId?: string;
    status: "ok" | "error" | "timeout";
    result?: unknown;
    error?: unknown;
  }[];
}

interface ModelResultView {
  content?: string;
  reasoningContent?: string;
  toolCalls?: unknown;
}

/** 每步预扣的保守单位（引擎无价格表；实结与超支处置都在 Core）。 */
const STEP_ESTIMATE = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 表面消息 → 模型协议消息（OpenAI 形状；DeepSeek 同形）。 */
function toModelMessage(m: SurfaceMessageView): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content,
      ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
    };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
      ...(m.toolCalls !== undefined
        ? {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id ?? "",
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
            })),
          }
        : {}),
    };
  }
  return { role: m.role, content: m.content };
}

/** 工具清单 → 模型协议工具声明。 */
function toModelTools(tools: EngineStepInputView["tools"]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      parameters: t.schema ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * 模型回答里的工具调用 → 表面形状。
 * 同时接受归一形状（`{id,name,arguments}`，mock）与 OpenAI 形状（`function.name`，真实 provider）。
 */
function normalizeToolCalls(value: unknown): { id?: string; name: string; arguments: unknown }[] {
  if (!Array.isArray(value)) return [];
  const out: { id?: string; name: string; arguments: unknown }[] = [];
  for (const raw of value) {
    const tc = asRecord(raw);
    if (!tc) continue;
    const fn = asRecord(tc.function);
    const name =
      typeof fn?.name === "string" ? fn.name : typeof tc.name === "string" ? tc.name : "";
    if (name === "") continue;
    let args: unknown = fn?.arguments ?? tc.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { raw: args };
      }
    }
    const id = typeof tc.id === "string" && tc.id !== "" ? tc.id : undefined;
    out.push({ ...(id !== undefined ? { id } : {}), name, arguments: args });
  }
  return out;
}

/**
 * 一步：调一次模型 → 决策。
 * - 有工具调用意图 = `act`（actions 交给 Core 校验与执行）；
 * - 没有 = `done`（summary = 模型正文）。
 * 模型回答正文无论哪种决策都回给 Core，由 Core 写 `MODEL_MESSAGE`（表面事件只有 Core 能写）。
 */
/**
 * 私有状态面（D3 故障半径用例的证据）：本模块无权威状态，快照只证明"跑在独立子进程"。
 * 循环上下文每步由 Core 投影给出，崩溃即丢——这正是 engine 可无状态重启的前提。
 */
export function snapshot() {
  return { pid: process.pid, kind: "engine-react" };
}

export async function step(
  input: EngineStepInputView,
  ctx: {
    client: {
      modelInvoke(req: {
        reqId: string;
        model: string;
        params: unknown;
        estimate: number;
      }): Promise<unknown>;
    };
    engine: unknown;
  },
) {
  const decl = ctx.engine as EngineDeclView | undefined;
  if (!decl || decl.loop !== "react") {
    throw new Error("engine declaration missing from bootstrap");
  }
  if (input.step > input.maxSteps) {
    throw new Error(`step ${input.step} exceeds maxSteps ${input.maxSteps}`);
  }

  const reqId = `${input.runId}:${input.step}`;
  const response = (await ctx.client.modelInvoke({
    reqId,
    model: decl.model.name,
    params: {
      messages: input.messages.map(toModelMessage),
      tools: toModelTools(input.tools),
      step: input.step,
    },
    estimate: STEP_ESTIMATE,
  })) as { result?: ModelResultView } | undefined;

  const result = asRecord(response?.result) ?? {};
  const content = typeof result.content === "string" ? result.content : "";
  const reasoningContent =
    typeof result.reasoningContent === "string" ? result.reasoningContent : undefined;
  const toolCalls = normalizeToolCalls(result.toolCalls);

  const message = {
    content,
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usageRef: { reqId },
  };

  if (toolCalls.length > 0) {
    return {
      decision: {
        kind: "act" as const,
        actions: toolCalls.map((tc, index) => ({
          tool: tc.name,
          params: tc.arguments,
          toolCallId: tc.id ?? `call-${input.step}-${index}`,
        })),
      },
      message,
    };
  }
  return {
    decision: { kind: "done" as const, summary: content === "" ? "done" : content },
    message,
  };
}
