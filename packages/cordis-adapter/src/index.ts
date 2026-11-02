/**
 * @keel/cordis-adapter —— Cordis 存量插件生态的接口级原型（口径见 docs/design/phase-1/05）。
 *
 * 一件事：把旧框架的"全局注册表"形状 `ctx.tools.register()` 映射为 Keel 的**按 scope 注册**
 * （单一事实源 = Core 的 ContextManager 分区，适配器不自存工具表）。
 * 映射不到的语义显式报错（ADAPTER/UNSUPPORTED），不静默降级——全量承接在 Phase 2。
 */

import type { ContextManager, RunRef } from "@keel/core";

/** 适配器本地错误：抛给存量插件，不入 Core 契约 §6 词表、不落账本、不过通道（发生在注册期）。 */
export class CordisAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CordisAdapterError";
    this.code = code;
  }
}

/** 旧框架的工具定义（handler 由插件自己留在 Cell 内执行，适配器不保存）。 */
export interface CordisToolDef {
  name: string;
  schema?: unknown;
  handler?: unknown;
}

/** 注册结果视图（旧代码常按返回对象继续挂属性）。 */
export interface CordisToolView {
  name: string;
  schemaVersion: number;
}

export interface CordisToolsApi {
  /** 本 scope 注册/更新工具；同名 = 版本 +1（覆盖语义映射）。 */
  register(def: CordisToolDef): CordisToolView;
  /** 下线工具；返回是否真的存在过（旧框架据此判断是否报错）。 */
  remove(name: string): boolean;
  /** 本 scope 可见工具表（无全局模式，V1/I5）。 */
  list(): CordisToolView[];
}

export interface CordisCtx {
  /** 绑定的 Run 引用（scope = 其 (agentId, sessionId)）；注册调用不接受作用域参数。 */
  readonly ref: Readonly<RunRef>;
  readonly tools: CordisToolsApi;
  /** 旧框架的跨插件共享状态：本原型显式拒绝（Phase 2 改为只读注入 + 显式能力申请）。 */
  readonly share: { get(key: string): unknown; set(key: string, value: unknown): void };
  /** 旧框架的副作用回收：本原型显式拒绝（改走补偿声明，见状态机稿）。 */
  readonly effects: { reclaim(id: string): unknown };
}

export interface CreateCordisCtxParams {
  ctx: ContextManager;
  ref: RunRef;
}

function assertRef(ref: RunRef | undefined | null): RunRef {
  const bad = !ref || !ref.agentId || !ref.sessionId || !ref.runId;
  if (bad) {
    throw new CordisAdapterError(
      "ADAPTER/SCOPE-REQUIRED",
      "cordis ctx must be bound to a {agentId,sessionId,runId} ref: Keel has no global tool registry",
    );
  }
  return ref;
}

/** 创建一个绑定了作用域的旧框架形状 ctx（宿主负责先 ctx.alloc(scope)）。 */
export function createCordisCtx(params: CreateCordisCtxParams): CordisCtx {
  const { ctx } = params;
  if (!ctx || typeof ctx.registerTool !== "function") {
    throw new CordisAdapterError("ADAPTER/SCOPE-REQUIRED", "missing Core ContextManager binding");
  }
  const ref = Object.freeze({ ...assertRef(params.ref) });
  const find = (name: string): CordisToolView | undefined =>
    ctx.discover(ref).find((t) => t.name === name);

  return {
    ref,
    tools: {
      register(def: CordisToolDef): CordisToolView {
        if (!def || typeof def.name !== "string" || def.name === "") {
          throw new CordisAdapterError("ADAPTER/SCOPE-REQUIRED", "tool name required");
        }
        // 版本号从 Core 现有条目推导（适配器不自存状态）；schemaVersion 0 = 未注册
        const entry = {
          name: def.name,
          schemaVersion: (find(def.name)?.schemaVersion ?? 0) + 1,
          schema: def.schema ?? null,
        };
        ctx.registerTool({ agentId: ref.agentId, sessionId: ref.sessionId }, entry);
        return { name: entry.name, schemaVersion: entry.schemaVersion };
      },
      remove(name: string): boolean {
        const existed = find(name) !== undefined;
        if (existed) ctx.removeTool({ agentId: ref.agentId, sessionId: ref.sessionId }, name);
        return existed;
      },
      list(): CordisToolView[] {
        return ctx.discover(ref).map((t) => ({ name: t.name, schemaVersion: t.schemaVersion }));
      },
    },
    share: {
      get(): unknown {
        throw unsupported("shared context read");
      },
      set(): void {
        throw unsupported("shared context write");
      },
    },
    effects: {
      reclaim(): unknown {
        throw unsupported("effect reclaim");
      },
    },
  };
}

function unsupported(what: string): CordisAdapterError {
  return new CordisAdapterError(
    "ADAPTER/UNSUPPORTED",
    `${what} is not mapped in the Phase 1 prototype: use read-only injection + declared capabilities (shared context) ` +
      `or compensation declaration (effects). Full semantics land with the Phase 2 adapter.`,
  );
}
