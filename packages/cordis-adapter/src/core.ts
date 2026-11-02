/**
 * 承接面本体（02 稿 §3）：旧 `ctx` 形状、承接面常量、端口契约与错误类。
 *
 * 三条姿态（与 01 稿 §1 判据同源，不可协商）：
 * 1. **不提供 ≠ 静默成功**：未映射的旧面一律抛错并写明改法去处；返回空表/undefined
 *    就是把旧框架的隐式降级搬进新框架；
 * 2. `ADAPTER/*` 只用于"旧面本身没映射"；运行期裁决失败一律原样浮出 Core 错误码
 *    （`AUTH/DENIED`、`CTX/SCOPE-UNKNOWN`），承接层不改写归因——归因链必须指向内核；
 * 3. 承接层**不持有工具表**：可见表的唯一持有者是 Core 的 scope 分区，执行体的唯一持有者
 *    是 Cell 的私有表（原型稿 §5 第 2 条继续有效）。
 */

/** 适配器本地错误：抛给存量插件，不入 Core 契约 §6 词表、不落账本、不过通道（发生在映射期）。 */
export class CordisAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CordisAdapterError";
    this.code = code;
  }
}

/** 旧框架的 handler 形状：`(params, ctx)`，ctx 即这里注入的旧形状面。 */
export type CordisHandler = (params: unknown, ctx: CordisCtx) => unknown;

/** 旧框架的工具定义（位置形与对象形都接受，见 `CordisToolsApi.register` 重载）。 */
export interface CordisToolDef {
  name: string;
  schema?: unknown;
  handler?: CordisHandler;
}

/** 注册结果视图（旧代码常按返回对象继续挂属性）。 */
export interface CordisToolView {
  name: string;
  schemaVersion: number;
}

/** 承接层唯一的注册出口形状——两个端口各实现一份，插件看到的形状一致。 */
export interface CordisRegistryPort {
  /** 注册/更新（同名 = 覆盖且版本 +1；版本由端口背后的事实源指派）。 */
  register(name: string, schema: unknown, handler?: CordisHandler): Promise<CordisToolView>;
  /** 撤名；返回是否真的存在过。 */
  remove(name: string): Promise<boolean>;
  /** 本 scope 可见工具表（无全局模式，V1/I5）。 */
  list(): Promise<CordisToolView[]>;
}

export interface CordisToolsApi {
  register(def: CordisToolDef): Promise<CordisToolView>;
  register(name: string, schema?: unknown, handler?: CordisHandler): Promise<CordisToolView>;
  remove(name: string): Promise<boolean>;
  list(): Promise<CordisToolView[]>;
}

export interface CordisCtx {
  readonly tools: CordisToolsApi;
  /** 旧框架的跨插件共享状态：显式拒绝（改为只读注入 + 显式能力申请，边界 #8）。 */
  readonly share: { get(key: string): unknown; set(key: string, value: unknown): void };
  /** 旧框架的副作用回收：显式拒绝（改为声明式补偿，边界 #9）。 */
  readonly effects: { reclaim(id: string): unknown };
  /** 能力插件不持钩子面（边界 #2 拆支 → #14 D 档通道）。 */
  readonly hooks: { register(name: string, fn?: unknown): unknown };
  /** 跨插件事件总线：通道不存在（边界 #15，C 档）。 */
  readonly bus: {
    emit(topic: string, payload?: unknown): unknown;
    on(topic: string, fn?: unknown): unknown;
  };
  /** 配置/密钥自取：改为声明 + 受控注入（边界 #4，B 档）。 */
  readonly config: { get(key: string): unknown };
  /** 自带网络面：改为声明 + 词表裁决（边界 #5，B 档；注意 02 稿 F4）。 */
  readonly net: { fetch(url: string, init?: unknown): unknown };
  /** 大模型直调（旧插件自带 SDK 与 key）：改为走网关（边界 #6，C 档）。 */
  readonly llm: { chat(prompt: unknown, opts?: unknown): unknown };
  /**
   * 作用域自省不提供：Cell 永不持有 (agentId, sessionId, runId)——读任何字段即抛，
   * 让"按会话编号做全局操作"的旧写法在这里就断掉（而不是返回 undefined 继续跑）。
   */
  readonly scope: never;
}

/** 各未映射面的改法去处（"不能这么写"必须配"这么写也能达到目的"）。 */
const WAY_OUT = {
  share:
    "keep state where it is produced (own Cell), expose via read-only injection + declared capability, or pass it through tool params — 边界 #8, C 档",
  effects:
    "declare compensation up front: manifest compensation.templates + runtime EFFECT_DECLARED — 边界 #9, C 档",
  llm: "call the model through the gateway (no credentials in plugin) via the Cell client invoke shape — 边界 #6, C 档",
  hooks:
    'hooks are declared by kind:"policy" manifests on the four-hook whitelist; capability plugins hold no hook surface — 边界 #2/#14, D 档',
  bus: "pass intent as tool-call params (authorized + ledgered), or read the ledger (read-only) — 边界 #15, C 档",
  config:
    "no manifest means no value: declare what you need and let the host inject it — 边界 #4, B 档（合成声明在切片②）",
  net: "outbound network is a declared capability with a host allow-list — 边界 #5, B 档；注意 02 稿 F4：当前进程后端不拦截舱内原生 fetch",
  scope:
    "the host stamps the scope on the channel binding and the Cell never learns it (02 稿 §3) — use tool params to carry any per-run label",
} as const;

function refused(what: string, wayOut: string): never {
  throw new CordisAdapterError(
    "ADAPTER/UNSUPPORTED",
    `${what} is not mapped: ${wayOut}（禁止静默降级——02 稿 §3 姿态 1）`,
  );
}

/**
 * 旧 ctx 的完整可见面清单——**B5 符号闭环的对照表**：
 * 合成样本里出现的每个 `ctx.*` 符号都必须命中这里某一项，否则即"未归类符号"（tests/cordis-symbol-scan.test.ts 机械核对）。
 */
export const CORDIS_SURFACE = {
  /** 本片已映射（A 档动作面）。 */
  mapped: ["tools.register", "tools.remove", "tools.list"] as const,
  /** 本片显式拒绝（抛 `ADAPTER/UNSUPPORTED`，附改法去处）。 */
  refused: [
    "share.get",
    "share.set",
    "effects.reclaim",
    "hooks.register",
    "bus.emit",
    "bus.on",
    "config.get",
    "net.fetch",
    "llm.chat",
  ] as const,
  /** 不提供（读取即抛）。 */
  withheld: ["scope"] as const,
} as const;

/** 由端口构造旧形状 ctx（两个端口共用同一面，差异只在端口背后）。 */
export function buildCordisCtx(port: CordisRegistryPort): CordisCtx {
  const tools: CordisToolsApi = {
    register(
      defOrName: CordisToolDef | string,
      schema?: unknown,
      handler?: CordisHandler,
    ): Promise<CordisToolView> {
      const body: CordisToolDef =
        typeof defOrName === "string" ? { name: defOrName, schema, handler } : (defOrName ?? {});
      const name = body.name;
      if (typeof name !== "string" || name.trim() === "") {
        return Promise.reject(
          new CordisAdapterError("ADAPTER/SCOPE-REQUIRED", "tool name required"),
        );
      }
      return port.register(name, body.schema ?? null, body.handler);
    },
    remove: (name: string) => port.remove(name),
    list: () => port.list(),
  };

  return {
    tools,
    share: {
      get(key: string): unknown {
        return refused(`shared context read (${key})`, WAY_OUT.share);
      },
      set(key: string): void {
        return refused(`shared context write (${key})`, WAY_OUT.share);
      },
    },
    effects: {
      reclaim(id: string): unknown {
        return refused(`effect reclaim (${id})`, WAY_OUT.effects);
      },
    },
    hooks: {
      register(name: string): unknown {
        return refused(`hook register (${name})`, WAY_OUT.hooks);
      },
    },
    bus: {
      emit(topic: string): unknown {
        return refused(`bus emit (${topic})`, WAY_OUT.bus);
      },
      on(topic: string): unknown {
        return refused(`bus on (${topic})`, WAY_OUT.bus);
      },
    },
    config: {
      get(key: string): unknown {
        return refused(`config read (${key})`, WAY_OUT.config);
      },
    },
    net: {
      fetch(url: string): unknown {
        return refused(`net fetch (${url})`, WAY_OUT.net);
      },
    },
    llm: {
      chat(): unknown {
        return refused("llm.chat", WAY_OUT.llm);
      },
    },
    // 读取任何字段都抛：让"想自报作用域"的旧写法在舱内就断掉
    scope: new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string): never {
        return refused(`scope introspection (${prop})`, WAY_OUT.scope);
      },
    }) as never,
  };
}
