/**
 * Cell 进程体 —— 架构总览 §4.3 / ADR-0005：一次 Run 独占一个 OS 进程（"水密隔舱"）。
 *
 * - 私有工具表（tool.provide）：只承载本 Cell 注册的工具；可见性裁决在 Core（本包不做全局表）。
 * - tool.exec（Core→Cell 方向）：执行工具；toolCallTimeoutMs 硬强制（C-D3），超时回
 *   {status:"timeout"}——结果未知语义，硬中断由 Supervisor killed 分类兜底。
 * - compensation.exec（切片④）：补偿动作分发（manifest 模板 action.ref → 插件 compensations
 *   导出表）；同一 toolCallTimeoutMs 硬强制；宿主补偿执行器经一次性新 Cell 进程调用
 *   （ADR-0005「新 Cell」路径），未知 actionRef 拒绝。
 * - cell.snapshot（切片④）：宿主轮边界索取私有状态（D3）；无快照面 = 无状态 Cell（{state:null}）。
 * - CellClient（Cell→Core 方向，契约 §3.3 可见面）：auth.check / budget.query / model.invoke /
 *   tool.discover / ledger.read（仅本 run）/ effect.declare（EFFECT_DECLARED 发起端，
 *   "先声明后动手"；模板校验与落账在 Core 侧，C-M1）。
 * - 无凭证、无直连网络：模型调用必经 Core 网关；工具越权由 Core 授权器拒绝。
 * - 崩溃语义（ADR-0005 crash 分类前提）：未捕获异常 = 进程非零退出（main.ts 显式注册）。
 */

import { ChannelError, FrameConn, type ConnStreams, type EventFrame } from "./protocol.js";

/** Cell 内工具（插件模块经 export const tools 提供）。 */
export interface CellTool {
  name: string;
  schema: unknown;
  handler: (params: unknown, ctx: { client: CellClient }) => Promise<unknown> | unknown;
}

/** tool.exec 结果 = 契约调度器 ToolExecutor 的返回形（切片③通道绑定）。 */
export type ToolExecResult =
  | { status: "ok"; result?: unknown; durationMs: number }
  | { status: "error" | "timeout"; error?: unknown; durationMs: number };

/** 越界效果声明（契约 §5 EFFECT_DECLARED 载荷；补偿闭环随切片④状态机执行）。 */
export interface EffectDeclaration {
  effectKind: string;
  targetSummary?: unknown;
  compensation: { actionRef: string; paramsDigest?: unknown; idempotency: string };
  probeRef?: string;
  dependsOn?: string[];
  retention?: unknown;
}

/** 补偿动作入参（宿主补偿执行器 → compensation.exec；切片④）。 */
export interface CompensationExecInput {
  actionRef: string;
  effectId: string;
  targetSummary?: unknown;
  paramsDigest?: unknown;
  /** undo = 补偿执行；probe = 结果核验（T05/T06 链路）。 */
  phase: "undo" | "probe";
}

/** 插件补偿动作处理器（export const compensations 表项；必须容忍目标不存在，状态机 §6）。 */
export type CompensationHandler = (input: CompensationExecInput) => Promise<unknown> | unknown;

/** Cell→Core 客户端（契约 §4 可见面矩阵 Cell 行；超时按 §7 默认表）。 */
export interface CellClient {
  authCheck(action: string, resource: string): Promise<{ allowed: boolean; reason?: string }>;
  budgetQuery(): Promise<unknown>;
  modelInvoke(req: {
    reqId: string;
    model: string;
    params: unknown;
    estimate: number;
  }): Promise<unknown>;
  toolDiscover(): Promise<unknown[]>;
  ledgerRead(filter: { types?: string[]; seqFrom?: number; seqTo?: number }): Promise<unknown>;
  declareEffect(decl: EffectDeclaration): Promise<{ effectId: string; seq: number }>;
}

export interface CellOptions extends ConnStreams {
  /** 工具调用超时（manifest C-D3 硬强制；宿主装配时传入）。 */
  toolCallTimeoutMs: number;
  now?: () => number;
}

export interface CellHandle {
  registerTool(tool: CellTool): void;
  /** 注册迁移钩（manifest migration.steps[].action.ref 对应的插件导出；无则 migrate 拒绝）。 */
  setMigration(fn: (oldState: unknown) => Promise<unknown> | unknown): void;
  /** 注册补偿动作表（插件 export const compensations；切片④）。 */
  setCompensations(map: Record<string, CompensationHandler>): void;
  /** 注册快照索取面（插件 export function snapshot；无注册 = 无状态 Cell，切片④）。 */
  setSnapshotProvider(fn: () => Promise<unknown> | unknown): void;
  /** A5：新 Cell 内、快照挂载后首轮前执行；失败由 Host 回退旧作用域。 */
  migrate(oldState: unknown): Promise<unknown>;
  /** 对端断开/通道关闭。 */
  done: Promise<void>;
  /** 观测事件订阅位（Core→Cell 单向通知；MVP 无推送方，仅保留路由）。 */
  onEvent(cb: (ev: EventFrame) => void): void;
}

// 契约 §7 默认超时表（Cell→Core 方向）
const TIMEOUT_AUTH = 50;
const TIMEOUT_BUDGET = 50;
const TIMEOUT_DISCOVER = 100;
const TIMEOUT_LEDGER = 1_000;
const TIMEOUT_EFFECT = 200;
const TIMEOUT_MODEL = 120_000;

export function startCell(opts: CellOptions): CellHandle {
  const conn = new FrameConn(opts);
  const tools = new Map<string, CellTool>();
  const compensations = new Map<string, CompensationHandler>();
  const now = opts.now ?? (() => Date.now());
  let migration: ((oldState: unknown) => Promise<unknown> | unknown) | null = null;
  let snapshotProvider: (() => Promise<unknown> | unknown) | null = null;

  const client: CellClient = {
    authCheck: (action, resource) => conn.request("auth.check", { action, resource }, TIMEOUT_AUTH),
    budgetQuery: () => conn.request("budget.query", {}, TIMEOUT_BUDGET),
    modelInvoke: (req) => conn.request("model.invoke", req, TIMEOUT_MODEL),
    toolDiscover: () => conn.request("tool.discover", {}, TIMEOUT_DISCOVER),
    ledgerRead: (filter) => conn.request("ledger.read", { filter }, TIMEOUT_LEDGER),
    declareEffect: (decl) => {
      const effectId = crypto.randomUUID();
      return conn.request("effect.declare", { effectId, ...decl }, TIMEOUT_EFFECT);
    },
  };

  conn.serve(async (op, params) => {
    switch (op) {
      case "tool.exec":
        return execTool(params as { tool: string; params?: unknown });
      case "compensation.exec": {
        const req = params as CompensationExecInput;
        const fn = compensations.get(req.actionRef);
        if (!fn) {
          throw new ChannelError(
            "CELL/ACTION-UNKNOWN",
            `compensation action not registered: ${req.actionRef}`,
            { actionRef: req.actionRef },
          );
        }
        return hardTimeout(() => fn(req), "CELL/COMPENSATION-FAILED");
      }
      case "cell.snapshot":
        return { state: snapshotProvider ? await snapshotProvider() : null };
      case "cell.migrate":
        if (!migration) {
          throw new ChannelError("CELL/MIGRATION-MISSING", "no migration hook registered");
        }
        return migration((params as { oldState: unknown }).oldState);
      default:
        throw new ChannelError("CELL/OP-UNKNOWN", `unknown op: ${op}`, { op });
    }
  });

  /** toolCallTimeoutMs 硬强制（C-D3）：超时后 handler 不可取消、结果/异常丢弃。 */
  async function hardTimeout(
    fn: () => Promise<unknown> | unknown,
    fallbackCode: string,
  ): Promise<ToolExecResult> {
    const t0 = now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(fn()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new ChannelError("TRANSPORT/TIMEOUT", "toolCallTimeoutMs exceeded"));
          }, opts.toolCallTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      return { status: "ok", result, durationMs: now() - t0 };
    } catch (err) {
      clearTimeout(timer);
      // shortcut: 超时后 handler 不可取消、其结果/异常丢弃；硬中断由 Supervisor killed 分类兜底
      if (timedOut) {
        return {
          status: "timeout",
          error: { code: "TRANSPORT/TIMEOUT", message: "toolCallTimeoutMs exceeded" },
          durationMs: now() - t0,
        };
      }
      return {
        status: "error",
        error: {
          code:
            typeof (err as { code?: unknown })?.code === "string"
              ? (err as { code: string }).code
              : fallbackCode,
          message: err instanceof Error ? err.message : String(err),
        },
        durationMs: now() - t0,
      };
    }
  }

  async function execTool(p: { tool: string; params?: unknown }): Promise<ToolExecResult> {
    const tool = tools.get(p.tool);
    if (!tool) {
      return {
        status: "error",
        error: { code: "CELL/TOOL-UNKNOWN", message: `tool not registered: ${p.tool}` },
        durationMs: 0,
      };
    }
    return hardTimeout(() => tool.handler(p.params, { client }), "CELL/TOOL-FAILED");
  }

  return {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    setMigration(fn) {
      migration = fn;
    },
    setCompensations(map) {
      for (const [ref, fn] of Object.entries(map)) compensations.set(ref, fn);
    },
    setSnapshotProvider(fn) {
      snapshotProvider = fn;
    },
    migrate(oldState) {
      if (!migration) {
        return Promise.reject(
          new ChannelError("CELL/MIGRATION-MISSING", "no migration hook registered"),
        );
      }
      return Promise.resolve(migration(oldState));
    },
    done: conn.done,
    onEvent(cb) {
      conn.onEvent(cb);
    },
  };
}
