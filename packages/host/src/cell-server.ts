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
  type ToolCatalog,
  type EffectDeclaredPayload,
  type Ledger,
  type LedgerReadFilter,
  type ModelGateway,
  type RunRef,
  type Scope,
} from "@keel/core";
import path from "node:path";
import type { FrameConn } from "@keel/cell-runtime";
import type { WorkspaceMode } from "@keel/runtime-context";
import { Workspace, type WorkspaceWriteResult } from "./workspace.js";
import type { EffectReceipt } from "@keel/runtime-context";
import type { RunPermissionView } from "./builtins.js";
import type { CompensationTemplateDecl } from "./assembler.js";
import type { EffectTracker } from "./effects.js";

export interface CellChannelBinding {
  scope: Scope;
  ref: RunRef;
  /** Cell 授权主体（auth.check / model.invoke 的 subject；Host 装配时确定）。 */
  subject: string;
  /** manifest 补偿模板（C-M1 运行时引用校验的对照表）。 */
  templates: Map<string, CompensationTemplateDecl>;
  /** 本 Run 的装配权限基线（workspace.write 的路径复核依据；缺省 = 全部拒绝）。 */
  permissions?: RunPermissionView[];
  /**
   * 工具注册/撤名通知（Phase 4 切片②）：Profile 装配器据此建立"工具 → Cell"归属，
   * 用作组合执行器的路由与重名复核。只是观察回调，不改变裁决与分区写入。
   */
  onToolChange?: (change: { name: string; registered: boolean }) => void;
}

export interface CellServerDeps {
  ledger: Ledger;
  auth: Authorizer;
  budget: Budgeter;
  ctx: ToolCatalog;
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
      // 流式三 op（切片⑤，ADR-0013 决策 1）：start 走授权 + 预扣 + 首页；next/cancel 只认
      // "本 run 本主体的活跃会话"——streamId 是标识符不是权限，越界与不存在同样回答（不留探测信道）。
      case "model.stream.start":
        return deps.gateway.streamStart(binding.ref, binding.subject, {
          reqId: str(p, "reqId"),
          model: str(p, "model"),
          params: p.params,
          estimate: num(p, "estimate"),
        });
      case "model.stream.next":
        return deps.gateway.streamNext(
          binding.ref,
          binding.subject,
          str(p, "streamId"),
          typeof p.limit === "number" ? p.limit : undefined,
        );
      case "model.stream.cancel":
        return deps.gateway.streamCancel(binding.ref, binding.subject, str(p, "streamId"));
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
      case "workspace.write":
        return workspaceWrite(binding, p, deps);
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
  binding.onToolChange?.({ name, registered: true });
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
  if (existed) {
    deps.ctx.removeTool(binding.scope, name);
    binding.onToolChange?.({ name, registered: false });
  }
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
  const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : undefined;
  const targetSummary = p.targetSummary ?? null;
  if (toolCallId && deps.tracker) {
    const existing = deps.tracker.findByCall(binding.ref, toolCallId, template.kind, targetSummary);
    if (existing) return { effectId: existing.effectId, seq: existing.seq };
  }
  const payload: EffectDeclaredPayload = {
    effectId,
    kind: template.kind,
    ...(toolCallId ? { toolCallId } : {}),
    targetSummary,
    compensationClass: template.compensationClass,
    compensation: {
      actionRef: template.action.ref,
      actionType: template.action.type,
      paramsDigest: comp.paramsDigest ?? null,
      idempotency: template.idempotency,
    },
    probeRef: template.probe?.ref ?? null,
    dependsOn,
    retention: p.retention ?? null,
  };
  const ev = await deps.ledger.append(binding.ref, "EFFECT_DECLARED", payload);
  deps.tracker?.declared(binding.ref, effectId, dependsOn, {
    seq: ev.seq,
    kind: template.kind,
    targetSummary,
    actionRef: template.action.ref,
    actionType: template.action.type,
    ...(toolCallId ? { toolCallId } : {}),
  });
  return { effectId, seq: ev.seq };
}

/**
 * 受治理写入（ADR-0018）：Host 执行真实 IO 并写收据。
 * 次序 = 授权 → 认领 effect（必须已声明）→ 路径/身份检查 → 写 → EFFECT_SETTLED.receipt。
 * 写失败按“干净失败”结算（不产生可补偿的 created 收据）；收据落账失败则尽力回滚本次创建。
 */
async function workspaceWrite(
  binding: CellChannelBinding,
  p: Record<string, unknown>,
  deps: CellServerDeps,
): Promise<{ receipt: EffectReceipt; bytes: number }> {
  if (!deps.tracker) {
    throw new KeelError("SCHED/MANIFEST-INVALID", "workspace.write requires an effect tracker", {});
  }
  const effectId = str(p, "effectId");
  const mode = p.mode;
  if (mode !== "create" && mode !== "overwrite") {
    throw new KeelError("TRANSPORT/BADFRAME", "workspace.write mode must be create|overwrite", {
      mode,
    });
  }
  const requested = str(p, "path");
  const content = typeof p.content === "string" ? p.content : null;
  if (content === null) {
    throw new KeelError("TRANSPORT/BADFRAME", "workspace.write requires string content", {});
  }
  // 授权先于认领：拒绝也留 AUTH_DENIED（路径按 resolve 后的资源比较；大小写按平台归一在 Workspace 内）
  const resolved = path.resolve(requested);
  const resource = `fs:${resolved.replace(/\\/g, "/")}`;
  const decision = await deps.auth.check(binding.ref, binding.subject, "fs.write", resource);
  if (!decision.allowed) {
    throw new KeelError("AUTH/DENIED", `workspace.write denied: ${decision.reason ?? resource}`, {
      cap: "fs.write",
      path: resolved,
    });
  }
  const meta = deps.tracker.claimWrite(binding.ref, effectId);
  if (meta.settled && meta.receipt) {
    // 幂等重放（重试同一 toolCall）：返回既有收据，不再写一次
    return { receipt: meta.receipt, bytes: meta.receipt.identity?.size ?? 0 };
  }
  // 声明目标与实际写入目标必须一致（防“guard 查 A、handler 写 B”）
  const declared = declaredPath(meta.targetSummary);
  if (declared && path.resolve(declared) !== resolved) {
    throw new KeelError("WORKSPACE/PATH", "workspace target does not match the declared effect", {
      declared,
      requested: resolved,
    });
  }
  const workspace = new Workspace({ permissions: binding.permissions ?? [] });
  let result: WorkspaceWriteResult;
  try {
    result = await workspace.write({
      effect: meta,
      mode: mode as WorkspaceMode,
      path: resolved,
      content,
    });
  } catch (err) {
    const cleaned = (err as { detail?: { cleaned?: unknown } }).detail?.cleaned;
    await deps.tracker
      .settleEffect(
        binding.ref,
        effectId,
        cleaned === false ? "unknown" : "failed-clean",
        undefined,
        { code: (err as { code?: unknown }).code ?? "WORKSPACE/IO", message: String(err) },
      )
      .catch(() => undefined);
    throw err;
  }
  try {
    await deps.tracker.settleEffect(binding.ref, effectId, "done", result.receipt);
  } catch (err) {
    await workspace.rollback(result.receipt);
    throw err;
  }
  return result;
}

function declaredPath(targetSummary: unknown): string | null {
  if (typeof targetSummary === "string") return targetSummary;
  if (typeof targetSummary !== "object" || targetSummary === null) return null;
  const v = (targetSummary as { path?: unknown }).path;
  return typeof v === "string" ? v : null;
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
