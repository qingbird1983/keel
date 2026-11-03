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

/**
 * 改法地面（切片③）：C 档"必须改一小段"的那几行改写后要调的**新面**，不是旧面改名。
 * 三条都映射内核既有的通道 op（`model.invoke` / `effect.declare` / `ledger.read`）——
 * 零新 op、零新错误码、零协议变更（04 稿 §2 F2）。
 */

/** `ctx.model.invoke` 的请求体：`estimate` 必填（预扣依据），计量由内核权威实结。 */
export interface CordisModelRequest {
  model: string;
  params?: unknown;
  /** 发起方估算（预扣额度）；缺它就无法诚实预扣，故必填。 */
  estimate: number;
}

/** 网关返回形（`replay:true` = 同 reqId 命中已结算调用：未重打上游、未重复计费）。 */
export interface CordisModelResult {
  result: unknown;
  usage: unknown;
  cost: number;
  replay: boolean;
}

/**
 * `ctx.effects.declare` 的入参：**没有 `effectId`、也没有 `compensation.actionRef`**——
 * 效果号由 Cell 侧 runtime 指派，补偿动作与幂等口径由 manifest 报关单决定（C-M1 焊点）：
 * 插件能临场编造的只有"我动了什么、动了哪个目标"。
 */
export interface CordisEffectDecl {
  effectKind: string;
  targetSummary?: unknown;
  /** 动作摘要（进账本，供补偿动作与审计对照）。 */
  paramsDigest?: unknown;
  dependsOn?: string[];
  retention?: unknown;
}

/** 声明回执（内核落账后给出的定位）。 */
export interface CordisEffectView {
  effectId: string;
  seq: number;
}

/** `ctx.ledger.read` 的过滤面：没有 runId 位——run 由通道盖章，插件不选 run。 */
export interface CordisLedgerFilter {
  types?: string[];
  seqFrom?: number;
  seqTo?: number;
}

/** 改法地面的出口形状（与注册端口分开：诊断端口背后没有网关/账本/追踪器，04 稿 §2 F7）。 */
export interface CordisGuidePort {
  modelInvoke(reqId: string, req: CordisModelRequest): Promise<CordisModelResult>;
  declareEffect(decl: CordisEffectDecl): Promise<CordisEffectView>;
  ledgerRead(filter: CordisLedgerFilter): Promise<unknown>;
}

/** 承接层构造旧 ctx 所需的两半：注册面 + 改法地面。缺任何一半都不该构造 ctx。 */
export interface CordisPorts {
  registry: CordisRegistryPort;
  guide: CordisGuidePort;
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
  /**
   * 旧框架的副作用回收：`reclaim` 显式拒绝（它就是"出事再临时决定回收"的形态，边界 #9）；
   * `declare` 是本行的**改法地面**（动手前报关，映射既有 `effect.declare` op）。
   */
  readonly effects: {
    reclaim(id: string): unknown;
    declare(decl: CordisEffectDecl): Promise<CordisEffectView>;
  };
  /**
   * 改法地面（边界 #6 的去处）：模型调用的唯一通道。
   * `reqId` 是**第一个必填参数**——幂等口径要求调用方给出请求号（契约 §8），
   * 自动生成等于每次都是新请求，"同请求不重复计费"这条保护就没有落点。
   */
  readonly model: {
    invoke(reqId: string, req: CordisModelRequest): Promise<CordisModelResult>;
  };
  /**
   * 改法地面（边界 #11/#12/#15 共同的"读只读账本"出路）：只见本 run，
   * run 由宿主在通道绑定上盖章——过滤面里出现 runId 即抛（不静默丢弃）。
   */
  readonly ledger: {
    read(filter?: CordisLedgerFilter): Promise<unknown>;
  };
  /** 能力插件不持钩子面（边界 #2 拆支 → #14 D 档通道）。 */
  readonly hooks: { register(name: string, fn?: unknown): unknown };
  /** 跨插件事件总线：通道不存在（边界 #15，C 档）。 */
  readonly bus: {
    emit(topic: string, payload?: unknown): unknown;
    on(topic: string, fn?: unknown): unknown;
  };
  /** 配置/密钥自取：显式拒绝（边界 #4，切片② 定稿改判 C——改声明能力，不再自取密钥）。 */
  readonly config: { get(key: string): unknown };
  /** 自带网络面：改为声明 + 词表裁决（边界 #5，B 档；注意 02 稿 F4）。 */
  readonly net: { fetch(url: string, init?: unknown): unknown };
  /** 大模型直调（旧插件自带 SDK 与 key）：显式拒绝，改法地面是上面的 `ctx.model.invoke`（边界 #6，C 档）。 */
  readonly llm: { chat(prompt: unknown, opts?: unknown): unknown };
  /**
   * 作用域自省不提供：Cell 永不持有 (agentId, sessionId, runId)——读任何字段即抛，
   * 让"按会话编号做全局操作"的旧写法在这里就断掉（而不是返回 undefined 继续跑）。
   */
  readonly scope: never;
}

/** 各未映射面的改法去处（"不能这么写"必须配"这么写也能达到目的"；切片③ 起有地面可指）。 */
const WAY_OUT = {
  share:
    "keep state where it is produced (own Cell), let the kernel carry the value as tool-call params, or read this run's ledger via ctx.ledger.read — 边界 #8, C 档（改法地面 = tierC-08-carry 样本）",
  effects:
    'declare before acting: manifest compensation.templates + ctx.effects.declare({effectKind, ...}) — 边界 #9, C 档（reclaim 就是"临时决定回收"的形态，不放行）',
  llm: "call the model through the gateway: ctx.model.invoke(reqId, {model, params, estimate}) — 边界 #6, C 档（reqId 必填且由调用方给：同请求重放不重复计费）",
  hooks:
    'hooks are declared by kind:"policy" manifests on the four-hook whitelist; capability plugins hold no hook surface — 边界 #2/#14, D 档',
  bus: "pass intent as tool-call params (authorized + ledgered), or read this run's ledger via ctx.ledger.read — 边界 #15, C 档（跨 run 订阅归 Phase 3）",
  config:
    "no self-fetched secrets: declare the capability instead (model → cap model.adapter then ctx.model.invoke; network → cap net.fetch with an allow-list) — 边界 #4, C 档（切片② 定稿改判；观察不到的调用面进缺项清单，03 稿 §4）",
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
 * 旧 `ctx.llm` 面（切片⑤ §3.4 第 5 步补的护栏）：`chat` 一直是显式拒（边界 #6，C 档），
 * 但**读未知成员**（如 `ctx.llm.chatStream`）今天拿到 `undefined`，随后是一次裸
 * `TypeError: ... is not a function`——没有改法去处，属"没交代"的一种形状。
 * 这里把该命名空间的**字符串成员**兜住：已知的 `chat` 照常拒，未知的也拒并指向网关改法；
 * 符号成员（inspect / `Symbol.toStringTag` 这类语言协议）透传——兜住它们等于让调试打印自己抛。
 *
 * 注意这**不是**"旧框架有 chatStream"的断言（我们不替旧框架发明 API）：本文件是护栏，
 * 真样本暴露出具体旧符号时按 B5 义务补边界表行。内核侧的流式通道（ADR-0013）也不在这里映射——
 * 它是 Core 能力回填，不是旧面的等价物。
 */
function llmSurface(): { chat(prompt: unknown, opts?: unknown): unknown } {
  const known = {
    chat(): unknown {
      return refused("llm.chat", WAY_OUT.llm);
    },
  };
  return new Proxy(known, {
    get(target, prop: string | symbol): unknown {
      // 符号成员透传（`Symbol.toStringTag`、Node 的自定义 inspect 等）：兜住它们等于让
      // 调试打印与序列化路径自己抛错——被拒的是**旧 API 名字**，不是语言协议。
      if (typeof prop !== "string") return Reflect.get(target, prop);
      if (prop in target) return (target as unknown as Record<string, unknown>)[prop];
      return refused(`llm.${prop}`, WAY_OUT.llm);
    },
  }) as typeof known;
}

/**
 * 旧 ctx 的完整可见面清单——**B5 符号闭环的对照表**：
 * 合成样本里出现的每个 `ctx.*` 符号都必须命中这里某一项，否则即"未归类符号"（tests/cordis-symbol-scan.test.ts 机械核对）。
 * 四桶互不重叠（index.test 机械核对）；**改法地面单列一桶、不进 `mapped`**——
 * `mapped` 的语义是"旧 API 已自动映射、代码不用改"，把需要改写的东西塞进去就是把 C 档谎报成 A 档（04 稿 §3.2）。
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
  /**
   * 改法地面（C 档改写后才能调用的 Keel 形状新面，映射内核既有通道 op）：
   * 出现在样本里是**预期**的——它们证明"改一小段"确实有去处，而不是手册上的愿望。
   */
  guide: ["model.invoke", "effects.declare", "ledger.read"] as const,
} as const;

/** 缺必填参数（异步面以拒绝的承诺浮现，与 `tools.*` 同一姿态：错误必须可见，不许悄悄返回成功）。 */
function argsMissing(what: string, why: string): Promise<never> {
  return Promise.reject(
    new CordisAdapterError("ADAPTER/ARGS-REQUIRED", `${what} is required: ${why}`),
  );
}

/** 由两半端口构造旧形状 ctx（两个端口共用同一面，差异只在端口背后；04 稿 §2 F7）。 */
export function buildCordisCtx(ports: CordisPorts): CordisCtx {
  const { registry, guide } = ports;
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
      return registry.register(name, body.schema ?? null, body.handler);
    },
    remove: (name: string) => registry.remove(name),
    list: () => registry.list(),
  };

  return {
    tools,
    /**
     * 边界 #6 的改法地面：`reqId` 必填且由调用方给（同 reqId 命中已结算调用 = 未重打上游、
     * 未重复计费）；`estimate` 必填（没有它就无法诚实预扣）。承接层不代造请求号——
     * 自动生成等于每次都是新请求，那条保护在这条路上直接失效（04 稿 §8 第 1 项）。
     */
    model: {
      invoke(reqId: string, req: CordisModelRequest): Promise<CordisModelResult> {
        if (typeof reqId !== "string" || reqId.trim() === "") {
          return argsMissing(
            "model.invoke(reqId, …): reqId",
            "the caller owns the request id: the gateway replays the same reqId without re-billing, so an auto-generated id is always a new request（边界 #6）",
          );
        }
        const body = (req ?? {}) as CordisModelRequest;
        if (typeof body.model !== "string" || body.model.trim() === "") {
          return argsMissing(
            "model.invoke: model",
            "which declared model to call（cap model.adapter）",
          );
        }
        if (
          typeof body.estimate !== "number" ||
          !Number.isFinite(body.estimate) ||
          body.estimate < 0
        ) {
          return argsMissing(
            "model.invoke: estimate",
            "the reservation is booked from your estimate; the kernel settles with its own authoritative metering",
          );
        }
        return guide.modelInvoke(reqId, {
          model: body.model,
          params: body.params,
          estimate: body.estimate,
        });
      },
    },
    /**
     * 边界 #11/#12/#15 共同的"读只读账本"出路：只见本 run，且 **run 由宿主在通道绑定上盖章**——
     * 过滤面里出现 `runId` 即抛（跨 run 读取归 Phase 3；静默丢弃等于假装拦截成功）。
     */
    ledger: {
      read(filter?: CordisLedgerFilter): Promise<unknown> {
        const f = (filter ?? {}) as Record<string, unknown>;
        if (f.runId !== undefined) {
          return argsMissing(
            "ledger.read: no runId",
            "the run is stamped on the channel binding by the host; cross-run reads are not on this surface（边界 #11，Phase 3 归观测生态）",
          );
        }
        const out: CordisLedgerFilter = {};
        if (Array.isArray(f.types)) out.types = f.types as string[];
        if (typeof f.seqFrom === "number") out.seqFrom = f.seqFrom;
        if (typeof f.seqTo === "number") out.seqTo = f.seqTo;
        return guide.ledgerRead(out);
      },
    },
    /**
     * 边界 #9 的改法地面：**动手前报关**。`effectId` 由 Cell 侧指派、补偿动作与幂等口径
     * 来自 manifest 的 `compensation.templates`（C-M1 焊点），所以这三个字段**出现即拒**——
     * 让插件以为自己能选补偿动作，就是把"临场编造"换了个名字放进来。
     */
    effects: {
      reclaim(id: string): unknown {
        return refused(`effect reclaim (${id})`, WAY_OUT.effects);
      },
      declare(decl: CordisEffectDecl): Promise<CordisEffectView> {
        const d = (decl ?? {}) as unknown as Record<string, unknown>;
        if (typeof d.effectKind !== "string" || d.effectKind.trim() === "") {
          return argsMissing(
            "effects.declare: effectKind",
            "it must match a declared compensation.templates kind — undeclared effects are refused by the kernel（C-M1）",
          );
        }
        for (const owned of ["effectId", "compensation", "probeRef"] as const) {
          if (d[owned] !== undefined) {
            return argsMissing(
              `effects.declare: no ${owned}`,
              `${owned} is not the plugin's to choose: the Cell assigns effectId and the manifest template fixes the compensation action and idempotency（C-M1）`,
            );
          }
        }
        return guide.declareEffect({
          effectKind: d.effectKind,
          ...(d.targetSummary !== undefined ? { targetSummary: d.targetSummary } : {}),
          ...(d.paramsDigest !== undefined ? { paramsDigest: d.paramsDigest } : {}),
          ...(Array.isArray(d.dependsOn) ? { dependsOn: d.dependsOn as string[] } : {}),
          ...(d.retention !== undefined ? { retention: d.retention } : {}),
        });
      },
    },
    share: {
      get(key: string): unknown {
        return refused(`shared context read (${key})`, WAY_OUT.share);
      },
      set(key: string): void {
        return refused(`shared context write (${key})`, WAY_OUT.share);
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
    llm: llmSurface(),
    // 读取任何字段都抛：让"想自报作用域"的旧写法在舱内就断掉
    scope: new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string): never {
        return refused(`scope introspection (${prop})`, WAY_OUT.scope);
      },
    }) as never,
  };
}
