/**
 * Cell 进程体 —— 架构总览 §4.3 / ADR-0005：一次 Run 独占一个 OS 进程（"水密隔舱"）。
 *
 * - 私有工具表（tool.provide）：只承载本 Cell 注册的工具；可见性裁决在 Core（本包不做全局表）。
 * - tool.exec（Core→Cell 方向）：执行工具；toolCallTimeoutMs 硬强制（C-D3），超时回
 *   {status:"timeout"}——结果未知语义，硬中断由 Supervisor killed 分类兜底。
 * - 治理切面（切片③，ADR-0015）：manifest governance 编译成计划随 bootstrap 送达；有计划的工具
 *   在 handler 前自动 guard → effect.declare，handler 只留业务（`ctx.effects` 只读）。
 * - compensation.exec（切片④）：补偿动作分发（manifest 模板 action.ref → 插件 compensations
 *   导出表）；同一 toolCallTimeoutMs 硬强制；宿主补偿执行器经一次性新 Cell 进程调用
 *   （ADR-0005「新 Cell」路径），未知 actionRef 拒绝。
 * - cell.snapshot（切片④）：宿主轮边界索取私有状态（D3）；无快照面 = 无状态 Cell（{state:null}）。
 * - CellClient（Cell→Core 方向，契约 §3.3 可见面）：auth.check / budget.query / model.invoke /
 *   tool.discover / tool.register / tool.remove（切片①：运行期按 scope 注册与撤名，**handler 不出舱**，
 *   版本号由内核指派）/ ledger.read（仅本 run）/ effect.declare（EFFECT_DECLARED 发起端，
 *   "先声明后动手"；模板校验与落账在 Core 侧，C-M1）。
 * - handle.client 暴露给承接层：旧框架形状 ctx 在舱内构造时唯一的内核出口（作用域由宿主盖章，本进程不持有）。
 * - 无凭证、无直连网络：模型调用必经 Core 网关；工具越权由 Core 授权器拒绝。
 * - 崩溃语义（ADR-0005 crash 分类前提）：未捕获异常 = 进程非零退出（main.ts 显式注册）。
 */

import { EffectScope, type EffectReceipt } from "@keel/runtime-context";
import type { EngineStepHandler, RegisteredToolView, StreamPageView } from "./cell-types.js";
import { ChannelError, FrameConn, type ConnStreams, type EventFrame } from "./protocol.js";
import { createWorkspaceCapability, type WorkspaceCapability } from "./workspace.js";
import {
  EMPTY_EFFECTS,
  canonicalDigest,
  guardResource,
  pickFields,
  type CellGovernancePlan,
  type DeclaredEffectView,
  type GovernedToolPlan,
} from "./governance.js";

export type {
  EngineStepContext,
  EngineStepHandler,
  RegisteredToolView,
  StreamPageView,
} from "./cell-types.js";

/** handler 上下文（治理动作不再由插件调用；`effects` 只读）。 */
export interface ToolExecutionContext {
  /** 业务能力出口（模型、账本等）。 */
  readonly client: CellClient;
  /** 本次调用已由框架声明的效果；无治理声明时为空数组。 */
  readonly effects: readonly DeclaredEffectView[];
  /** 受治理写入能力；无 effect 可绑定或未声明时调用会明确失败。 */
  readonly workspace: WorkspaceCapability;
  /** 本次工具调用标识（重试幂等载体；旧调用方缺省）。 */
  readonly toolCallId?: string;
}

/** Cell 内工具（插件模块经 export const tools 提供）。 */
export interface CellTool {
  name: string;
  schema: unknown;
  handler: (params: unknown, ctx: ToolExecutionContext) => Promise<unknown> | unknown;
}

/**
 * 插件 setup 上下文（R4，ADR-0017）：只给资源清理与工具登记，不给任意内核句柄。
 * `effect` 的清理动作在 Cell 正常收尾（cell.dispose）时 LIFO 执行；它是资源清理，
 * 不是业务补偿（写文件/外发请求仍走 workspace/效果收据）。
 */
export interface PluginSetupContext {
  effect(disposer: () => void | Promise<void>): () => void;
  readonly tools: {
    register(tool: CellTool): Promise<RegisteredToolView>;
    remove(name: string): Promise<boolean>;
  };
}

/** tool.exec 结果 = 契约调度器 ToolExecutor 的返回形（切片③通道绑定）。 */
export type ToolExecResult =
  | { status: "ok"; result?: unknown; durationMs: number }
  | { status: "error" | "timeout"; error?: unknown; durationMs: number };

/** 越界效果声明（契约 §5 EFFECT_DECLARED 载荷；补偿闭环随切片④状态机执行）。 */
export interface EffectDeclaration {
  effectKind: string;
  targetSummary?: unknown;
  /**
   * `actionRef` 与 `idempotency` **不是发起方可决定的量**：服务端按 manifest 报关单填
   * `template.action.ref` 与 `template.idempotency`（C-M1 焊点——临场编造的补偿进不来）。
   * 两者保留为可选只为兼容既有调用方；提交值不改变落账载荷。切片③的承接层面因此只暴露
   * `paramsDigest`（04 稿 §3.1 施工期细化：可选化是类型层收敛，帧载荷与裁决均未变）。
   */
  compensation: { actionRef?: string; paramsDigest?: unknown; idempotency?: string };
  probeRef?: string;
  dependsOn?: string[];
  retention?: unknown;
  /** 发起声明的工具调用标识（R4 重试去重；宿主按它复用 effectId）。 */
  toolCallId?: string;
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

/**
 * 策略插件的插话处理体（切片④回填项 ①，ADR-0012 决策 1/2）。
 *
 * 形状刻意薄到只有一进一出：入参 = 内核给出的 hook 入参（不含任何可操作句柄），
 * 出参 = verdict 原样。**裁决与响应禁区校验都在内核的 HookBus**——把校验挪进舱内
 * 等于让被审者自审（ADR-0012 决策 2）。时限也不在这里造：策略舱没有 `toolCallTimeoutMs`
 * 这个量（报关单 `resources` 必须是空对象），唯一预算是宿主侧 hook 请求超时 + HookBus 超时。
 */
export type PolicyHookHandler = (input: unknown) => Promise<unknown> | unknown;

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
  /** 本 scope 运行期注册/更新工具（契约 §4.6，切片①）：**只提交 name+schema，handler 不出舱**。 */
  registerTool(name: string, schema: unknown): Promise<RegisteredToolView>;
  /** 本 scope 撤名（契约 §4.6）；返回是否真的存在过。 */
  removeTool(name: string): Promise<boolean>;
  ledgerRead(filter: { types?: string[]; seqFrom?: number; seqTo?: number }): Promise<unknown>;
  declareEffect(decl: EffectDeclaration): Promise<{ effectId: string; seq: number }>;
  /** 受治理写入（ADR-0018）：宿主执行真实 IO 并返回收据；Cell 不直接写文件。 */
  workspaceWrite(req: {
    effectId: string;
    mode: "create" | "overwrite";
    path: string;
    content: string;
    toolCallId?: string;
  }): Promise<{ receipt: EffectReceipt; bytes: number }>;
  /**
   * 流式一页（ADR-0013 决策 1 的舱内视图；本包不依赖 @keel/core，故为结构化同形类型）。
   * `done:true` = 会话已终局；`truncated:true` = 断流/取消（已产出部分照常结算）。
   */
  modelStreamStart(req: {
    reqId: string;
    model: string;
    params: unknown;
    estimate: number;
  }): Promise<StreamPageView>;
  /** 逐页取片：不 next 就不向上游取——背压由构造消解（ADR-0013 决策 2）。 */
  modelStreamNext(streamId: string, limit?: number): Promise<StreamPageView>;
  /** 主动收摊：已产出部分结算并标截断。 */
  modelStreamCancel(
    streamId: string,
  ): Promise<{ settled: boolean; cost: number; truncated: boolean }>;
}

export interface CellOptions extends ConnStreams {
  /** 工具调用超时（manifest C-D3 硬强制；宿主装配时传入）。 */
  toolCallTimeoutMs: number;
  /**
   * 装载门（ADR-0011）：为 true 时，本 Cell 在 `markReady()` 之前**不受理**任何对端请求
   * （帧照常读取与排队，不应答、不丢、不报错）。两个真实进程入口都开启它：
   * 默认入口在静态工具登记完成后开闸，承接层入口在旧插件 activation 完成后开闸——
   * 于是"第一轮决策看见空工具表"这条路被结构性关掉。
   */
  loadGate?: boolean;
  /**
   * 治理计划（04 稿 / ADR-0015）：宿主从 manifest 纯编译后经 bootstrap 送达。
   * 缺省 = 无切面，`tool.exec` 走老路径（handler 仍收 `{client, effects:[]}`）。
   */
  governance?: CellGovernancePlan;
  /** engine 插件专用：报关单 `engine` 段（bootstrap 送达；其余 kind 不设）。 */
  engine?: unknown;
  now?: () => number;
}

export interface CellHandle {
  registerTool(tool: CellTool): void;
  /** 撤本 Cell 执行表条目（运行期下线与注册失败回滚共用）；返回是否真的存在过。 */
  removeTool(name: string): boolean;
  /** 读执行表条目（承接层在覆盖注册被内核拒绝时据此把旧 handler 放回；表本身仍只在 Cell 内）。 */
  getTool(name: string): CellTool | undefined;
  /** Cell→Core 客户端（承接层在舱内构造旧 API 面时的唯一出口；作用域由宿主通道盖章）。 */
  readonly client: CellClient;
  /** 注册迁移钩（manifest migration.steps[].action.ref 对应的插件导出；无则 migrate 拒绝）。 */
  setMigration(fn: (oldState: unknown) => Promise<unknown> | unknown): void;
  /** 注册补偿动作表（插件 export const compensations；切片④）。 */
  setCompensations(map: Record<string, CompensationHandler>): void;
  /** 注册 engine 的一步（插件 export function step；Phase 4 切片④）。 */
  setEngineStep(fn: EngineStepHandler): void;
  /**
   * 注册策略插话表（策略舱专用；切片④，ADR-0012）。**与 `setCompensations` 不同**：
   * 这里登记的是"本舱能应答哪几个 hook"，宿主只会按报关单声明的名字来问——问了没登记的
   * 名字不会静默走默认值，而是以 `CELL/ACTION-UNKNOWN` 明确拒绝（归因链要能指到"没登记"）。
   */
  setHooks(map: Record<string, PolicyHookHandler>): void;
  /** 注册快照索取面（插件 export function snapshot；无注册 = 无状态 Cell，切片④）。 */
  setSnapshotProvider(fn: () => Promise<unknown> | unknown): void;
  /** 注册模块级 dispose（在资源 effect 之前执行；R4）。 */
  setDisposeHook(fn: () => Promise<unknown> | unknown): void;
  /** 插件 setup 上下文（资源 effect + 运行期工具登记）。 */
  setupContext(): PluginSetupContext;
  /** 正常收尾：模块 dispose → 资源 effect LIFO（幂等；宿主经 cell.dispose 调用）。 */
  dispose(): Promise<void>;
  /** A5：新 Cell 内、快照挂载后首轮前执行；失败由 Host 回退旧作用域。 */
  migrate(oldState: unknown): Promise<unknown>;
  /**
   * 开装载门（ADR-0011；`loadGate` 未开时是空操作）。**装载义务的一部分**：
   * 漏调会让本舱永远不应答——宿主侧表现为就绪探测超时并拒绝装配（不是静默等待）。
   */
  markReady(): void;
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
// 契约 §4.6 切片①新增两行（含一次 Core 状态写 + 挂起变更日志追加）
const TIMEOUT_TOOL_REGISTER = 200;
const TIMEOUT_TOOL_REMOVE = 200;
// workspace.write 的等待上限取本次工具调用的硬预算（不新增独立时限；0 = 未配置时 5s）
const WORKSPACE_TIMEOUT_FALLBACK = 5_000;
// 流式（切片⑤，ADR-0013 决策 7）：通道请求上限取契约 §7 的**流式总长 300s** 那一档，
// 内核侧单次等待取**首字节 30s** 那一档——两个都是既有数字，不新增时限；
// 内核一定会在自己的等待到期后先应答（截断页），于是通道超时这条只可能是真故障。
const TIMEOUT_MODEL_STREAM = 300_000;

export function startCell(opts: CellOptions): CellHandle {
  const conn = new FrameConn(opts);
  const tools = new Map<string, CellTool>();
  const compensations = new Map<string, CompensationHandler>();
  const hooks = new Map<string, PolicyHookHandler>();
  // 计划转 Map 持有：避免 __proto__ / constructor 等对象键歧义（04 稿 §4.4）。
  const governed = new Map<string, GovernedToolPlan>(Object.entries(opts.governance?.tools ?? {}));
  const now = opts.now ?? (() => Date.now());
  let migration: ((oldState: unknown) => Promise<unknown> | unknown) | null = null;
  let engineStep: EngineStepHandler | null = null;
  let snapshotProvider: (() => Promise<unknown> | unknown) | null = null;
  let disposeHook: (() => Promise<unknown> | unknown) | null = null;
  const resources = new EffectScope();
  let disposing: Promise<void> | null = null;

  const client: CellClient = {
    authCheck: (action, resource) => conn.request("auth.check", { action, resource }, TIMEOUT_AUTH),
    budgetQuery: () => conn.request("budget.query", {}, TIMEOUT_BUDGET),
    modelInvoke: (req) => conn.request("model.invoke", req, TIMEOUT_MODEL),
    toolDiscover: () => conn.request("tool.discover", {}, TIMEOUT_DISCOVER),
    registerTool: (name, schema) =>
      conn.request<RegisteredToolView>("tool.register", { name, schema }, TIMEOUT_TOOL_REGISTER),
    removeTool: (name) => conn.request<boolean>("tool.remove", { name }, TIMEOUT_TOOL_REMOVE),
    ledgerRead: (filter) => conn.request("ledger.read", { filter }, TIMEOUT_LEDGER),
    declareEffect: (decl) => {
      const effectId = crypto.randomUUID();
      return conn.request("effect.declare", { effectId, ...decl }, TIMEOUT_EFFECT);
    },
    workspaceWrite: (req) =>
      conn.request(
        "workspace.write",
        req,
        opts.toolCallTimeoutMs > 0 ? opts.toolCallTimeoutMs : WORKSPACE_TIMEOUT_FALLBACK,
      ),
    modelStreamStart: (req) =>
      conn.request<StreamPageView>("model.stream.start", req, TIMEOUT_MODEL_STREAM),
    modelStreamNext: (streamId, limit) =>
      conn.request<StreamPageView>(
        "model.stream.next",
        limit === undefined ? { streamId } : { streamId, limit },
        TIMEOUT_MODEL_STREAM,
      ),
    modelStreamCancel: (streamId) =>
      conn.request<{ settled: boolean; cost: number; truncated: boolean }>(
        "model.stream.cancel",
        { streamId },
        TIMEOUT_MODEL_STREAM,
      ),
  };

  // 装载门（ADR-0011）：loadGate 开启时，请求处理挂在这个 promise 上直到 markReady()。
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  conn.serve(async (op, params) => {
    // 装载门（ADR-0011）：门未开时，对端请求在此挂起——帧已读取、不丢不报错，只是**不应答**。
    // 宿主侧因此可以把"收到一次应答"当作"插件装载完成"的凭据（就绪探测 = cell.snapshot）。
    if (opts.loadGate === true) await gate;
    switch (op) {
      case "tool.exec":
        return execTool(params as { tool: string; params?: unknown; toolCallId?: string });
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
      case "engine.step": {
        // Host→Cell 的"一步"（ADR-0023）：插件只拿模型调用出口，没有工具执行入口。
        if (!engineStep) {
          throw new ChannelError("CELL/OP-UNKNOWN", "engine.step not registered", { op });
        }
        return await engineStep(params, { client, engine: opts.engine });
      }
      case "cell.snapshot":
        return { state: snapshotProvider ? await snapshotProvider() : null };
      case "cell.dispose":
        await disposeResources();
        return {};
      case "policy.hook": {
        // 策略舱方向（ADR-0012）：不设舱内时限（F11——策略没有 toolCallTimeoutMs 这个量），
        // 预算唯一来源是宿主侧请求超时 + 内核 HookBus 超时；两处都走既有 fallback 口径。
        const req = params as { hook?: unknown; input?: unknown };
        const fn = hooks.get(String(req.hook));
        if (!fn) {
          throw new ChannelError(
            "CELL/ACTION-UNKNOWN",
            `policy hook not registered: ${String(req.hook)}`,
            { hook: req.hook },
          );
        }
        return await fn(req.input);
      }
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

  async function execTool(p: {
    tool: string;
    params?: unknown;
    toolCallId?: string;
  }): Promise<ToolExecResult> {
    const tool = tools.get(p.tool);
    if (!tool) {
      return {
        status: "error",
        error: { code: "CELL/TOOL-UNKNOWN", message: `tool not registered: ${p.tool}` },
        durationMs: 0,
      };
    }
    // 整个拦截器链都在 toolCallTimeoutMs 之内（超时语义不变，04 稿 §4.4）。
    return hardTimeout(
      () => runGoverned(tool, governed.get(p.tool), p.params, p.toolCallId),
      "CELL/TOOL-FAILED",
    );
  }

  /**
   * 拦截器链（04 稿 §4.4）：guard → 逐个 effect.declare → handler。
   * 任一步失败 = handler 不执行（fail-closed，先声明后动手）；无计划 = 老路径。
   */
  async function runGoverned(
    tool: CellTool,
    plan: GovernedToolPlan | undefined,
    params: unknown,
    toolCallId?: string,
  ): Promise<unknown> {
    if (!plan) {
      return tool.handler(params, {
        client,
        effects: EMPTY_EFFECTS,
        workspace: createWorkspaceCapability(client, EMPTY_EFFECTS, toolCallId),
        ...(toolCallId ? { toolCallId } : {}),
      });
    }

    if (plan.guard) {
      const resource = guardResource(plan.guard, params);
      const decision = await client.authCheck(plan.guard.cap, resource);
      if (!decision.allowed) {
        throw new ChannelError(
          "AUTH/DENIED",
          `governance guard denied: ${plan.guard.cap} ${resource}`,
          { cap: plan.guard.cap, resource, reason: decision.reason },
        );
      }
    }

    const effects: DeclaredEffectView[] = [];
    for (const e of plan.effects ?? []) {
      const targetSummary = pickFields(params, e.targetFields, "effect target");
      const paramsDigest = e.digestFields
        ? canonicalDigest(pickFields(params, e.digestFields, "effect digest"))
        : undefined;
      const r = await client.declareEffect({
        effectKind: e.kind,
        targetSummary,
        compensation: paramsDigest ? { paramsDigest } : {},
        ...(toolCallId ? { toolCallId } : {}),
      });
      effects.push({
        kind: e.kind,
        effectId: r.effectId,
        seq: r.seq,
        targetSummary,
        ...(paramsDigest ? { paramsDigest } : {}),
      });
    }

    const view = Object.freeze(effects.map((e) => Object.freeze(e)));
    return tool.handler(params, {
      client,
      effects: view,
      workspace: createWorkspaceCapability(client, view, toolCallId),
      ...(toolCallId ? { toolCallId } : {}),
    });
  }

  /** setup 期登记：先写本地执行表，再跨通道发布；发布失败回滚本地表。 */
  async function registerAndPublish(tool: CellTool): Promise<RegisteredToolView> {
    if (tools.has(tool.name)) {
      throw new ChannelError("CELL/TOOL-EXISTS", `tool already registered: ${tool.name}`, {
        tool: tool.name,
      });
    }
    tools.set(tool.name, tool);
    try {
      return await client.registerTool(tool.name, tool.schema ?? null);
    } catch (err) {
      tools.delete(tool.name);
      throw err;
    }
  }

  function setupContext(): PluginSetupContext {
    return {
      effect: (disposer) => resources.effect(disposer),
      tools: {
        register: registerAndPublish,
        remove: async (name) => {
          const old = tools.get(name);
          if (!old) return false;
          tools.delete(name);
          try {
            return await client.removeTool(name);
          } catch (err) {
            tools.set(name, old);
            throw err;
          }
        },
      },
    };
  }

  /** 正常收尾：模块 dispose 先于资源 effect（业务清理 → 资源清理）；幂等。 */
  function disposeResources(): Promise<void> {
    if (disposing) return disposing;
    disposing = (async () => {
      const errors: unknown[] = [];
      if (disposeHook) {
        try {
          await disposeHook();
        } catch (err) {
          errors.push(err);
        }
      }
      try {
        await resources.dispose();
      } catch (err) {
        errors.push(err);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "cell dispose failed");
      }
    })();
    return disposing;
  }

  return {
    client,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    removeTool(name) {
      return tools.delete(name);
    },
    getTool(name) {
      return tools.get(name);
    },
    setMigration(fn) {
      migration = fn;
    },
    setCompensations(map) {
      for (const [ref, fn] of Object.entries(map)) compensations.set(ref, fn);
    },
    setEngineStep(fn) {
      engineStep = fn;
    },
    setHooks(map) {
      for (const [name, fn] of Object.entries(map)) hooks.set(name, fn);
    },
    setSnapshotProvider(fn) {
      snapshotProvider = fn;
    },
    setDisposeHook(fn) {
      disposeHook = fn;
    },
    setupContext,
    dispose: disposeResources,
    migrate(oldState) {
      if (!migration) {
        return Promise.reject(
          new ChannelError("CELL/MIGRATION-MISSING", "no migration hook registered"),
        );
      }
      return Promise.resolve(migration(oldState));
    },
    markReady() {
      // 计划绑定校验（04 稿 §4.4）：点名的工具必须已在本地执行表登记，否则装载即失败——
      // 可见失败优于“声明了但永远不生效”。
      for (const name of governed.keys()) {
        if (!tools.has(name)) {
          throw new Error(`governance plan references unregistered tool: ${name}`);
        }
      }
      openGate(); // 幂等：重复调用无副作用（promise 只能 resolve 一次）
    },
    done: conn.done,
    onEvent(cb) {
      conn.onEvent(cb);
    },
  };
}
