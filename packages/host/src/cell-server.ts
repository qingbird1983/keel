/**
 * Core 侧通道服务 —— 契约 §3.3 可见面矩阵 Cell 行的服务端实现：
 * Cell 只见 auth.check / budget.query / model.invoke / tool.discover / context.*（本 scope）/
 * ledger.read（本 run）；作用域与主体由通道绑定盖章，Cell 不可自报（防越界伪装）。
 *
 * effect.declare（C-M1 焊点）：effectKind 必须命中 manifest 已声明模板——未声明即拒绝
 * 且不留副作用（无 EFFECT_DECLARED 落账）。账本写入经 ledger.append（gateway 直写先例，
 * 调度器仍为轮内事件唯一编排者）。切片④：dependsOn 声明期校验（成环/未知引用即拒）+
 * 效果追踪器登记（EFFECT_SETTLED 由宿主按工具结果结算，契约 §4.1 注记⑥）。
 */

import {
  KeelError,
  type Authorizer,
  type Budgeter,
  type ContextManager,
  type EffectDeclaredPayload,
  type Ledger,
  type LedgerReadFilter,
  type ModelGateway,
  type RunRef,
  type Scope,
} from "@keel/core";
import type { FrameConn } from "@keel/cell-runtime";
import type { CompensationTemplateDecl } from "./assembler.js";
import type { EffectTracker } from "./effects.js";

export interface CellChannelBinding {
  scope: Scope;
  ref: RunRef;
  /** Cell 授权主体（auth.check / model.invoke 的 subject；Host 装配时确定）。 */
  subject: string;
  /** manifest 补偿模板（C-M1 运行时引用校验的对照表）。 */
  templates: Map<string, CompensationTemplateDecl>;
}

export interface CellServerDeps {
  ledger: Ledger;
  auth: Authorizer;
  budget: Budgeter;
  ctx: ContextManager;
  gateway: ModelGateway;
  /** 效果追踪器（切片④；缺省 = 不结算，效果留待恢复投影——仅测试用）。 */
  tracker?: EffectTracker;
}

/** 在 FrameConn 上挂 Cell 可见面服务（conn 同实例亦承载 Host→Cell 的 tool.exec 请求）。 */
export function serveCellChannel(
  conn: FrameConn,
  binding: CellChannelBinding,
  deps: CellServerDeps,
): void {
  conn.serve(async (op, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (op) {
      case "auth.check":
        return deps.auth.check(binding.ref, binding.subject, str(p, "action"), str(p, "resource"));
      case "budget.query":
        return deps.budget.query(binding.ref);
      case "model.invoke":
        return deps.gateway.invoke(binding.ref, binding.subject, {
          reqId: str(p, "reqId"),
          model: str(p, "model"),
          params: p.params,
          estimate: num(p, "estimate"),
        });
      case "tool.discover":
        return deps.ctx.discover(binding.ref);
      case "tool.register":
        return registerTool(binding, p, deps);
      case "tool.remove":
        return removeTool(binding, p, deps);
      case "ledger.read": {
        // §3.3：仅本 run——filter.runId 强制覆盖，Cell 传入值一律忽略
        const f = (p.filter ?? {}) as Record<string, unknown>;
        const filter: LedgerReadFilter = {
          runId: binding.ref.runId,
          ...(Array.isArray(f.types) ? { types: f.types as LedgerReadFilter["types"] } : {}),
          ...(typeof f.seqFrom === "number" ? { seqFrom: f.seqFrom } : {}),
          ...(typeof f.seqTo === "number" ? { seqTo: f.seqTo } : {}),
        };
        return deps.ledger.read(
          filter,
          typeof p.cursor === "string" ? p.cursor : undefined,
          typeof p.limit === "number" ? p.limit : undefined,
        );
      }
      case "effect.declare":
        return declareEffect(binding, p, deps);
      default:
        // 可见面矩阵外 = 通道误用（帧语义层坏用法）
        throw new KeelError("TRANSPORT/BADFRAME", `op not visible to Cell: ${op}`, { op });
    }
  });
}

/**
 * 运行期注册（契约 §4.6 切片①，ADR-0010 决策 1/4/6）：
 * **先裁决后写状态**——未声明 `tool.provide` 即拒并落 `AUTH_DENIED`，两半都不写；
 * 版本号由内核按本 scope 现有条目指派，Cell 提交的任何版本号一律忽略（单一事实源）；
 * 载荷只取 name/schema，**handler 永不进分区**（执行体留在 Cell 私有表）。
 */
async function registerTool(
  binding: CellChannelBinding,
  p: Record<string, unknown>,
  deps: CellServerDeps,
): Promise<{ name: string; schemaVersion: number }> {
  const name = str(p, "name");
  const decision = await deps.auth.check(binding.ref, binding.subject, "tool.register", name);
  if (!decision.allowed) {
    throw new KeelError("AUTH/DENIED", `tool.register denied: ${decision.reason ?? name}`, {
      name,
      action: "tool.register",
    });
  }
  const current = deps.ctx.discover(binding.ref).find((t) => t.name === name);
  deps.ctx.registerTool(binding.scope, {
    name,
    schemaVersion: (current?.schemaVersion ?? 0) + 1,
    schema: p.schema ?? null,
  });
  return { name, schemaVersion: (current?.schemaVersion ?? 0) + 1 };
}

/** 撤名（同上先裁决后写）；返回是否真的存在过——旧框架据此判断是否报错，不静默给 false。 */
async function removeTool(
  binding: CellChannelBinding,
  p: Record<string, unknown>,
  deps: CellServerDeps,
): Promise<boolean> {
  const name = str(p, "name");
  const decision = await deps.auth.check(binding.ref, binding.subject, "tool.remove", name);
  if (!decision.allowed) {
    throw new KeelError("AUTH/DENIED", `tool.remove denied: ${decision.reason ?? name}`, {
      name,
      action: "tool.remove",
    });
  }
  const existed = deps.ctx.discover(binding.ref).some((t) => t.name === name);
  if (existed) deps.ctx.removeTool(binding.scope, name);
  return existed;
}

/** C-M1 焊点：effectKind 命中模板才落 EFFECT_DECLARED（拒绝 = 无副作用）。 */
async function declareEffect(
  binding: CellChannelBinding,
  p: Record<string, unknown>,
  deps: CellServerDeps,
): Promise<{ effectId: string; seq: number }> {
  const effectId = str(p, "effectId");
  const template = binding.templates.get(str(p, "effectKind"));
  if (!template) {
    throw new KeelError("SCHED/MANIFEST-INVALID", "effectKind not declared in manifest templates", {
      effectKind: p.effectKind,
      declared: [...binding.templates.keys()],
    });
  }
  const comp = (p.compensation ?? {}) as Record<string, unknown>;
  const dependsOn = Array.isArray(p.dependsOn) ? (p.dependsOn as string[]) : [];
  if (deps.tracker) deps.tracker.validateDependency(binding.ref, effectId, dependsOn);
  const payload: EffectDeclaredPayload = {
    effectId,
    kind: template.kind,
    targetSummary: p.targetSummary ?? null,
    compensationClass: template.compensationClass,
    compensation: {
      actionRef: template.action.ref,
      paramsDigest: comp.paramsDigest ?? null,
      idempotency: template.idempotency,
    },
    probeRef: template.probe?.ref ?? null,
    dependsOn,
    retention: p.retention ?? null,
  };
  const ev = await deps.ledger.append(binding.ref, "EFFECT_DECLARED", payload);
  deps.tracker?.declared(binding.ref, effectId, dependsOn);
  return { effectId, seq: ev.seq };
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new KeelError("TRANSPORT/BADFRAME", `missing string param "${key}"`, { key });
  }
  return v;
}

function num(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new KeelError("TRANSPORT/BADFRAME", `missing number param "${key}"`, { key });
  }
  return v;
}
