/**
 * engine 驱动（Phase 4 切片④，03 稿 E1/E3/E4/E5/E7；ADR-0023）。
 *
 * 结构：**循环的决策逻辑在 engine Cell，回合的推进在 Core**。
 * Core 每轮把投影好的消息 + 工具清单发给 `engine.step`，engine 在一步内调模型并返回
 * `{decision, message?}`；Core 校验决策、写表面事件、执行工具、结算预算、写账本，
 * 再把结果作为下一轮入参。**不新增 Cell→Core 的工具执行通道**。
 *
 * 本文件是 Host 侧胶水：它把 `RunDriver`（调度器唯一认识的决策缝）接到 engine Cell 上。
 * engine 本身没有账本/表面写入入口，所有账本事实仍只有 Core 写。
 */

import {
  ERROR_CODES,
  KeelError,
  appendModelMessage,
  projectSurface,
  type DriverAction,
  type DriverDecision,
  type Ledger,
  type LedgerEvent,
  type ModelMessagePayload,
  type RoundContext,
  type RunDriver,
  type RunRef,
  type SurfaceToolCall,
} from "@keel/core";
import type { EngineDecl } from "./assembler.js";
import type { SupervisedCell } from "./supervisor.js";

/** engine 一步的请求（03 稿 E3 的封闭形状）。 */
export interface EngineStepInput {
  runId: string;
  step: number;
  maxSteps: number;
  messages: ReturnType<typeof projectSurface>;
  tools: { name: string; schemaVersion: number; schema: unknown }[];
  lastResult?: {
    tool: string;
    toolCallId?: string;
    status: "ok" | "error" | "timeout";
    result?: unknown;
    error?: unknown;
  }[];
}

/** engine 一步的应答（E3 + 切片④实施注记：`message` 承载 Core 要写的 MODEL_MESSAGE）。 */
export interface EngineStepResponse {
  decision:
    | { kind: "act"; actions: { tool: string; params: unknown; toolCallId: string }[] }
    | { kind: "done"; summary: unknown };
  message?: {
    content: string;
    reasoningContent?: string;
    toolCalls?: SurfaceToolCall[];
    usageRef?: { reqId: string };
  };
}

/**
 * 协议违规（§6）：**不新增错误码**——reasonCode 用 `ENGINE_PROTOCOL`，
 * 错误对象只是"带 code 的结构化错误"（调度器按 code 落 RUN_FAILED）。
 */
export class EngineProtocolError extends Error {
  readonly code = "ENGINE_PROTOCOL";
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "EngineProtocolError";
    this.detail = detail;
  }
}

/** 舱退出（E6 / R8）：engine Cell 在一步中间消失，原因码独立于通用 cell-crash 分类。 */
class EngineExitedError extends Error {
  readonly code = "ENGINE_EXITED";
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "EngineExitedError";
    this.detail = detail;
  }
}

export interface EngineDriverOptions {
  cell: SupervisedCell;
  engine: EngineDecl;
  ledger: Ledger;
  ref: RunRef;
}

function codedError(code: string, message: string, detail?: unknown): Error {
  if ((ERROR_CODES as readonly string[]).includes(code)) {
    return new KeelError(code as (typeof ERROR_CODES)[number], message, detail);
  }
  const err = new Error(message) as Error & { code: string; detail?: unknown };
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new EngineProtocolError(`engine.step response has unknown fields at ${where}`, {
      where,
      unknown,
    });
  }
}

/** engine 驱动的唯一职责：把一次 `engine.step` 变成调度器能消费的决策。 */
export class EngineDriver implements RunDriver {
  private readonly cell: SupervisedCell;
  private readonly engine: EngineDecl;
  private readonly ledger: Ledger;
  private readonly ref: RunRef;

  constructor(opts: EngineDriverOptions) {
    this.cell = opts.cell;
    this.engine = opts.engine;
    this.ledger = opts.ledger;
    this.ref = opts.ref;
  }

  async decide(ctx: RoundContext): Promise<DriverDecision> {
    // 最后一道闸（E7）：超步数 = 结构性上限，不是协议违规，也不是预算耗尽。
    if (ctx.round > this.engine.maxSteps) {
      return { done: true, summary: "max-steps", haltReason: "MAX_STEPS" };
    }

    const events = (await this.ledger.read({ runId: this.ref.runId })).events;
    const messages = projectSurface(events);
    const toolNames = new Set(this.engine.tools);
    const tools = ctx.tools
      .filter((t) => toolNames.has(t.name))
      .map((t) => ({ name: t.name, schemaVersion: t.schemaVersion, schema: t.schema }));

    const input: EngineStepInput = {
      runId: this.ref.runId,
      step: ctx.round,
      maxSteps: this.engine.maxSteps,
      messages,
      tools,
      ...(ctx.history.length > 0 ? { lastResult: lastResults(ctx) } : {}),
    };

    let raw: unknown;
    try {
      raw = await this.cell.stepEngine(input);
    } catch (err) {
      const translated = translateStepError(err);
      if (translated instanceof GracefulExhaustion) {
        // graceful：不失败，正常收束并落 reasonCode（与动作级 graceful 同形）。
        return { done: true, summary: "budget-exhausted", haltReason: translated.reasonCode };
      }
      throw translated;
    }

    const response = this.validate(raw, new Set(tools.map((t) => t.name)));
    const since = ctx.events.length > 0 ? Math.max(...ctx.events) : 0;

    // 表面事件：模型回答只能由 Core 写（Cell 无账本通道）。
    if (response.message) {
      const payload: ModelMessagePayload = {
        content: response.message.content,
        ...(response.message.reasoningContent !== undefined
          ? { reasoningContent: response.message.reasoningContent }
          : {}),
        ...(response.message.toolCalls !== undefined
          ? { toolCalls: response.message.toolCalls }
          : {}),
        ...(response.message.usageRef !== undefined ? { usageRef: response.message.usageRef } : {}),
      };
      await appendModelMessage(this.ledger, this.ref, payload);
    }

    // D5：本步的模型事件（网关直写，不在调度器 h.events 里）显式进入 basedOn。
    // 无论有没有 message 都重读一次：模型事件不依赖 message 是否返回。
    const after = (await this.ledger.read({ runId: this.ref.runId })).events;
    const basedOn = after
      .filter(
        (e) =>
          e.seq > since &&
          (e.type === "MODEL_INVOKED" || e.type === "MODEL_USAGE" || e.type === "MODEL_MESSAGE"),
      )
      .map((e) => e.seq);

    if (response.decision.kind === "done") {
      return { done: true, summary: response.decision.summary, basedOn };
    }
    const actions: DriverAction[] = response.decision.actions.map((a) => ({
      kind: "tool",
      tool: a.tool,
      params: a.params,
      toolCallId: a.toolCallId,
    }));
    return { done: false, summary: { kind: "act", actions: actions.length }, actions, basedOn };
  }

  /** 封闭形状校验（E3 / §6）：未知字段、未知工具名、非法动作一律拒绝该步。 */
  private validate(raw: unknown, availableTools: Set<string>): EngineStepResponse {
    const obj = asRecord(raw);
    if (!obj)
      throw new EngineProtocolError("engine.step must return an object", { got: typeof raw });
    rejectUnknownKeys(obj, ["decision", "message"], "response");
    const decision = asRecord(obj.decision);
    if (!decision) {
      throw new EngineProtocolError("engine.step response requires a decision object", {
        field: "decision",
      });
    }
    const kind = decision.kind;
    if (kind === "act") {
      rejectUnknownKeys(decision, ["kind", "actions"], "decision");
      if (!Array.isArray(decision.actions) || decision.actions.length === 0) {
        throw new EngineProtocolError("act decision requires a non-empty actions array", {
          field: "decision.actions",
        });
      }
      const actions = decision.actions.map((value, index) => {
        const a = asRecord(value);
        if (!a) {
          throw new EngineProtocolError(`action #${index} must be an object`, {
            field: `decision.actions[${index}]`,
          });
        }
        rejectUnknownKeys(a, ["tool", "params", "toolCallId"], `decision.actions[${index}]`);
        if (typeof a.tool !== "string" || a.tool.length === 0) {
          throw new EngineProtocolError(`action #${index} requires a tool name`, {
            field: `decision.actions[${index}].tool`,
          });
        }
        if (!availableTools.has(a.tool)) {
          // 未声明 = 不存在（E9）：不静默忽略，也不"尽力执行"。
          throw new EngineProtocolError(`action #${index} names an undeclared tool`, {
            field: `decision.actions[${index}].tool`,
            tool: a.tool,
            declared: [...availableTools],
          });
        }
        if (!("params" in a)) {
          throw new EngineProtocolError(`action #${index} requires params`, {
            field: `decision.actions[${index}].params`,
          });
        }
        if (typeof a.toolCallId !== "string" || a.toolCallId.length === 0) {
          throw new EngineProtocolError(`action #${index} requires a toolCallId`, {
            field: `decision.actions[${index}].toolCallId`,
          });
        }
        return { tool: a.tool, params: a.params, toolCallId: a.toolCallId };
      });
      return {
        decision: { kind: "act", actions },
        ...(obj.message !== undefined ? { message: this.validateMessage(obj.message) } : {}),
      };
    }
    if (kind === "done") {
      rejectUnknownKeys(decision, ["kind", "summary"], "decision");
      if (!("summary" in decision)) {
        throw new EngineProtocolError("done decision requires a summary", {
          field: "decision.summary",
        });
      }
      return {
        decision: { kind: "done", summary: decision.summary },
        ...(obj.message !== undefined ? { message: this.validateMessage(obj.message) } : {}),
      };
    }
    throw new EngineProtocolError('decision.kind must be "act" or "done"', {
      field: "decision.kind",
      value: kind,
    });
  }

  private validateMessage(value: unknown): NonNullable<EngineStepResponse["message"]> {
    const m = asRecord(value);
    if (!m) throw new EngineProtocolError("message must be an object", { field: "message" });
    rejectUnknownKeys(m, ["content", "reasoningContent", "toolCalls", "usageRef"], "message");
    if (typeof m.content !== "string") {
      throw new EngineProtocolError("message.content must be a string", {
        field: "message.content",
      });
    }
    if (m.reasoningContent !== undefined && typeof m.reasoningContent !== "string") {
      throw new EngineProtocolError("message.reasoningContent must be a string", {
        field: "message.reasoningContent",
      });
    }
    let toolCalls: SurfaceToolCall[] | undefined;
    if (m.toolCalls !== undefined) {
      if (!Array.isArray(m.toolCalls)) {
        throw new EngineProtocolError("message.toolCalls must be an array", {
          field: "message.toolCalls",
        });
      }
      toolCalls = m.toolCalls.map((value, index) => {
        const tc = asRecord(value);
        if (!tc || typeof tc.name !== "string" || tc.name.length === 0) {
          throw new EngineProtocolError(`toolCalls[${index}] requires a name`, {
            field: `message.toolCalls[${index}]`,
          });
        }
        if (tc.id !== undefined && typeof tc.id !== "string") {
          throw new EngineProtocolError(`toolCalls[${index}].id must be a string`, {
            field: `message.toolCalls[${index}].id`,
          });
        }
        return {
          ...(tc.id !== undefined ? { id: tc.id } : {}),
          name: tc.name,
          arguments: tc.arguments,
        };
      });
    }
    let usageRef: { reqId: string } | undefined;
    if (m.usageRef !== undefined) {
      const ref = asRecord(m.usageRef);
      if (!ref || typeof ref.reqId !== "string" || ref.reqId.length === 0) {
        throw new EngineProtocolError("message.usageRef requires a reqId", {
          field: "message.usageRef",
        });
      }
      usageRef = { reqId: ref.reqId };
    }
    return {
      content: m.content,
      ...(m.reasoningContent !== undefined ? { reasoningContent: m.reasoningContent } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(usageRef !== undefined ? { usageRef } : {}),
    };
  }
}

function lastResults(ctx: RoundContext): EngineStepInput["lastResult"] {
  return ctx.history.map((outcome) => {
    const action = outcome.action;
    if (action.kind !== "tool") {
      return {
        tool: action.kind,
        status: outcome.ok ? ("ok" as const) : ("error" as const),
        ...(outcome.ok ? { result: outcome.resultDigest } : { error: outcome.error }),
      };
    }
    return {
      tool: action.tool,
      ...(action.toolCallId !== undefined ? { toolCallId: action.toolCallId } : {}),
      status: outcome.ok ? ("ok" as const) : ("error" as const),
      ...(outcome.ok ? { result: outcome.resultDigest } : { error: outcome.error }),
    };
  });
}

/**
 * 一步失败 → 原因码（§6 / E7）：
 * - 通道断（Cell 消失）= `ENGINE_EXITED`（R8 的 reasonCode；不新增错误码）；
 * - 超时 = `TRANSPORT/TIMEOUT`（结果未知，本轮失败）；
 * - 预算耗尽 = 既有 `BUDGET/EXHAUSTED` 收束语义（graceful → 正常停机，其余 → 失败）；
 * - 其余契约错误码原样透传（`GATEWAY/UPSTREAM-ERROR` / `AUTH/DENIED` …）。
 */
function translateStepError(err: unknown): Error {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  const detail = (err as { detail?: unknown })?.detail;
  if (code === "TRANSPORT/BADFRAME") {
    return new EngineExitedError("engine cell exited during engine.step", detail);
  }
  if (code === "SCHED/BACKPRESSURE") {
    // 收尾中的舱拒绝新步 = 这一步不会再有应答：对 engine 而言与"舱退出"同一件事
    // （`kill()` 先把 phase 置 halting，再杀进程；窗口内到达的请求走这条）。
    return new EngineExitedError("engine cell is draining; step refused", detail);
  }
  if (code === "BUDGET/EXHAUSTED") {
    const mode = (detail as { mode?: unknown } | undefined)?.mode;
    if (mode === "graceful") {
      // 调度器不认识"graceful 的驱动层耗尽"，用 haltReason 落既有 RUN_HALTED 形状。
      return new GracefulExhaustion();
    }
    return codedError("BUDGET/EXHAUSTED", message, detail);
  }
  if (typeof code === "string") return codedError(code, message, detail);
  // 无码异常 = 引擎实现自身的错误：不冒充网关错误，交给调度器的 DRIVER-ERROR 默认落点。
  return err instanceof Error ? err : new Error(message);
}

/**
 * graceful 预算耗尽：驱动层把它翻译成一次"正常收束 + reasonCode"，与调度器
 * 对动作级 graceful 的处理保持同一账本形状（RUN_HALTED{reasonCode}）。
 */
export class GracefulExhaustion extends Error {
  readonly reasonCode = "BUDGET/EXHAUSTED-GRACEFUL";

  constructor() {
    super("budget exhausted (graceful)");
    this.name = "GracefulExhaustion";
  }
}

/** 账本事件读取捷径（测试/报告用）。 */
export function modelEventsOf(events: readonly LedgerEvent[]): LedgerEvent[] {
  return events.filter(
    (e) => e.type === "MODEL_INVOKED" || e.type === "MODEL_USAGE" || e.type === "MODEL_MESSAGE",
  );
}
