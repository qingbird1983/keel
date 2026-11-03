/**
 * 宿主端口（诊断 / 验收施加面）：直接绑 Core 的 ContextManager，Promise 立即 resolve。
 *
 * 它**不承载 handler**：宿主持有插件执行体既无意义也破 I1，所以经此端口注册的工具
 * "可见而不可执行"——这是既定边界（02 稿 §2 F2），Phase 1 的 A1 用它当增删施加通道。
 * 真实迁入路径是 `cell-port.ts`（舱内端口）。
 *
 * 切片③新增的**改法地面**（`ctx.model.invoke` / `ctx.effects.declare` / `ctx.ledger.read`）
 * 在本端口**逐项显式拒绝**（`ADAPTER/PORT-UNSUPPORTED`，04 稿 §2 F7）：宿主侧这里没有网关、
 * 没有账本订阅、没有效果追踪器，"看起来能调"就是假链路——真链路只在舱内端口那条路上。
 */

import type { ContextManager, RunRef } from "@keel/core";
import {
  buildCordisCtx,
  CordisAdapterError,
  type CordisCtx,
  type CordisGuidePort,
  type CordisRegistryPort,
} from "./core.js";

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

/** 宿主侧端口：单一事实源仍是 Core 分区（版本从现有条目推导，本端口不自存表）。 */
export function hostRegistryPort(params: CreateCordisCtxParams): CordisRegistryPort {
  const { ctx } = params;
  if (!ctx || typeof ctx.registerTool !== "function") {
    throw new CordisAdapterError("ADAPTER/SCOPE-REQUIRED", "missing Core ContextManager binding");
  }
  const ref = Object.freeze({ ...assertRef(params.ref) });
  const scope = { agentId: ref.agentId, sessionId: ref.sessionId };
  const find = (name: string) => ctx.discover(ref).find((t) => t.name === name);

  return {
    async register(name, schema) {
      const entry = {
        name,
        schemaVersion: (find(name)?.schemaVersion ?? 0) + 1,
        schema: schema ?? null,
      };
      ctx.registerTool(scope, entry);
      return { name: entry.name, schemaVersion: entry.schemaVersion };
    },
    async remove(name) {
      const existed = find(name) !== undefined;
      if (existed) ctx.removeTool(scope, name);
      return existed;
    },
    async list() {
      return ctx.discover(ref).map((t) => ({ name: t.name, schemaVersion: t.schemaVersion }));
    },
  };
}

/**
 * 宿主侧的改法地面 = 三面全部拒绝。
 * 错误码与"旧面没映射"（`ADAPTER/UNSUPPORTED`）分开：这里不是没映射，是**这条端口后面没有内核**。
 */
export function hostGuideRefused(): CordisGuidePort {
  const refuse = (face: string): never => {
    throw new CordisAdapterError(
      "ADAPTER/PORT-UNSUPPORTED",
      `${face} is not available on the host port: it binds the Core context partition only (no gateway / ledger / effect tracker behind it). Real model calls, effect declarations and ledger reads happen in the plugin's own process via createCordisCellCtx — 诊断端口不假装能跑真链路（04 稿 §2 F7）`,
    );
  };
  return {
    async modelInvoke() {
      return refuse("ctx.model.invoke");
    },
    async declareEffect() {
      return refuse("ctx.effects.declare");
    },
    async ledgerRead() {
      return refuse("ctx.ledger.read");
    },
  };
}

/** 宿主侧构造的旧形状 ctx（Phase 1 原型的调用形状保持不变，方法改为 async）。 */
export function createCordisCtx(params: CreateCordisCtxParams): CordisCtx {
  return buildCordisCtx({ registry: hostRegistryPort(params), guide: hostGuideRefused() });
}
