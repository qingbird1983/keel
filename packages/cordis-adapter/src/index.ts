/**
 * @keel/cordis-adapter —— Cordis 存量插件生态的承接层（口径见 docs/design/phase-2/02）。
 *
 * 一件事：把旧框架的"全局注册表"形状 `ctx.tools.*` 映射为 Keel 的**按 scope 注册**——
 * 可见表的唯一持有者是 Core 的 ContextManager 分区，执行体的唯一持有者是 Cell 的私有工具表，
 * **承接层不自存工具表**。映射不到的语义显式报错（`ADAPTER/UNSUPPORTED`）并附改法去处，
 * 绝不静默降级（01 稿 §1 判据 3）。
 *
 * 两个端口，同一形状（`CordisPorts` = 注册面 + 改法地面）：
 * - `createCordisCtx({ctx, ref})`（宿主端口，Phase 1 原型路径）：绑 Core 分区，用于诊断与验收施加面；
 *   它不承载 handler，所以经它注册的工具"可见而不可执行"（既定边界，非缺陷）；
 *   切片③的三个改法面在本端口**逐项拒绝**（`ADAPTER/PORT-UNSUPPORTED`——背后没有网关/账本/追踪器）。
 * - `createCordisCellCtx(cell)`（舱内端口，真实迁入路径）：注册先写 Cell 执行表、再跨通道写内核分区，
 *   内核拒绝即回滚执行表；无 handler 的注册从源头拒绝（否则造出的正是那个空壳形态）。
 *
 * 改法地面（切片③，04 稿 §3.1）：`ctx.model.invoke` / `ctx.effects.declare` / `ctx.ledger.read`
 * 是 C 档改写后才能调用的**新面**（映射 CellClient 既有 op），不是旧面改名——旧面
 * （`llm.chat` / `effects.reclaim` / `share.*` / `bus.*` / `config.get` / `net.fetch`）一条都不放行。
 *
 * 旧面在舱内是**异步**的：跨进程问内核就是有一次往返。被否的"同步返回 + 后台 flush"要求插件
 * 自算版本号（等于把全局注册表搬进插件进程），且失败发生在插件看不见的时刻（02 稿 §6）。
 *
 * 本文件只做聚合导出；本体在 `core.ts`（承接面与端口契约）、`host-port.ts`、`cell-port.ts`、
 * `legacy-shape.ts`（形状归一化）、`cell-entry.ts`（Cell 进程入口，宿主按路径 spawn）。
 */

export {
  buildCordisCtx,
  CORDIS_SURFACE,
  CordisAdapterError,
  type CordisCtx,
  type CordisEffectDecl,
  type CordisEffectView,
  type CordisGuidePort,
  type CordisHandler,
  type CordisLedgerFilter,
  type CordisModelRequest,
  type CordisModelResult,
  type CordisPorts,
  type CordisRegistryPort,
  type CordisToolDef,
  type CordisToolView,
  type CordisToolsApi,
} from "./core.js";
export {
  createCordisCtx,
  hostGuideRefused,
  hostRegistryPort,
  type CreateCordisCtxParams,
} from "./host-port.js";
export { createCordisCellCtx } from "./cell-port.js";
export {
  normalizeLegacyExtras,
  normalizeLegacyModule,
  type CordisActivator,
  type CordisExtras,
} from "./legacy-shape.js";
