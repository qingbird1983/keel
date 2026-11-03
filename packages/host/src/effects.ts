/**
 * 效果追踪器（切片④，契约 §4.1 注记⑥）：EFFECT_SETTLED 的宿主写入方。
 *
 * - cell-server 的 declareEffect 登记未结效果 → Supervisor 的 executor 包装在工具调用
 *   返回后按结果映射结算：ok → done；error/timeout → unknown（保守，契约 §6「结果未知」，
 *   落补偿稿 T05/T06 verify-pending）。崩溃 → 未结效果留在账本（declared 未闭环），
 *   由恢复投影保守并入补偿集合（ADR-0004 §4.4 先核对再续跑）。
 * - 落点序 = EFFECT_DECLARED → EFFECT_SETTLED → TOOL_RESULT（executor 先结算再返回给调度器）。
 * - 账本写入经 ledger.append（gateway 直写先例；调度器仍为轮内事件唯一编排者）。
 * - 声明期 dependsOn 校验（补偿稿 §5.2 成环即拒绝）：引用必须是本 run 已声明效果，
 *   且不得成环——跨 run 引用不在本 run 图内，自然被拒。
 *
 * 2026-11-03（ADR-0018/R4）：效果可能由受治理操作**自行结算**（workspace.write 在写成功后
 * 立即写 `EFFECT_SETTLED.receipt`），因此结算从「工具返回时批量」改为「按 effectId 可单独结算」；
 * `settleFor` 只处理仍未结的效果。`toolCallId` 用于重试去重（同一次调用的同 kind/目标复用 effectId）。
 */

import { KeelError, type Ledger, type RunRef } from "@keel/core";
import type { EffectReceipt } from "@keel/runtime-context";

export interface DeclaredEffectMeta {
  effectId: string;
  seq: number;
  kind: string;
  targetSummary: unknown;
  actionRef: string;
  actionType: "plugin" | "builtin";
  toolCallId?: string;
  settled: boolean;
  receipt?: EffectReceipt;
}

interface RunState {
  /** 未结 effectId。 */
  open: Set<string>;
  /** effectId → dependsOn（声明序依赖图）。 */
  graph: Map<string, string[]>;
  /** effectId → 元数据（收据/去重/结算）。 */
  meta: Map<string, DeclaredEffectMeta>;
  /** `${toolCallId}|${kind}|${targetKey}` → effectId（重试去重）。 */
  calls: Map<string, string>;
}

export class EffectTracker {
  private readonly ledger: Ledger;
  private readonly runs = new Map<string, RunState>();

  constructor(deps: { ledger: Ledger }) {
    this.ledger = deps.ledger;
  }

  /** declareEffect 落账后登记（未结）。 */
  declared(
    ref: RunRef,
    effectId: string,
    dependsOn: string[],
    meta?: Omit<DeclaredEffectMeta, "effectId" | "settled">,
  ): void {
    const st = this.state(ref.runId);
    st.open.add(effectId);
    st.graph.set(effectId, [...dependsOn]);
    st.meta.set(effectId, {
      effectId,
      seq: meta?.seq ?? 0,
      kind: meta?.kind ?? "",
      targetSummary: meta?.targetSummary ?? null,
      actionRef: meta?.actionRef ?? "",
      actionType: meta?.actionType ?? "plugin",
      ...(meta?.toolCallId ? { toolCallId: meta.toolCallId } : {}),
      settled: false,
    });
    if (meta?.toolCallId) {
      st.calls.set(callKey(meta.toolCallId, meta.kind, meta.targetSummary), effectId);
    }
  }

  /** 同一次 toolCall 的重复声明（重试）→ 复用既有 effectId；找不到返回 undefined。 */
  findByCall(
    ref: RunRef,
    toolCallId: string,
    kind: string,
    targetSummary: unknown,
  ): DeclaredEffectMeta | undefined {
    const id = this.state(ref.runId).calls.get(callKey(toolCallId, kind, targetSummary));
    return id ? this.state(ref.runId).meta.get(id) : undefined;
  }

  /** 声明期 dependsOn 校验：引用必须全部是本 run 已声明的效果，且不构成环。 */
  validateDependency(ref: RunRef, effectId: string, dependsOn: string[]): void {
    const g = this.state(ref.runId).graph;
    for (const dep of dependsOn) {
      if (!g.has(dep)) {
        throw new KeelError(
          "SCHED/MANIFEST-INVALID",
          `dependsOn references unknown effect: ${dep}`,
          {
            runId: ref.runId,
            effectId,
            dep,
          },
        );
      }
    }
    // 环检测：新增点未入图，从各 dep 沿边出发，能到达 effectId 即成环
    const seen = new Set<string>();
    const stack = [...dependsOn];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === effectId) {
        throw new KeelError("SCHED/MANIFEST-INVALID", `dependsOn cycle detected at ${cur}`, {
          runId: ref.runId,
          effectId,
        });
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of g.get(cur) ?? []) stack.push(next);
    }
  }

  /**
   * 受治理写入前认领 effect：必须已声明；已结算且带收据 = 幂等重放（返回既有收据），
   * 已结算但无收据 = 状态不合法（拒绝第二次写）。
   */
  claimWrite(ref: RunRef, effectId: string): DeclaredEffectMeta {
    const meta = this.state(ref.runId).meta.get(effectId);
    if (!meta) {
      throw new KeelError("SCHED/NOT-FOUND", "effect not declared in this run", {
        runId: ref.runId,
        effectId,
      });
    }
    if (meta.settled && !meta.receipt) {
      throw new KeelError("SCHED/MANIFEST-INVALID", "effect already settled without receipt", {
        runId: ref.runId,
        effectId,
      });
    }
    return meta;
  }

  /**
   * 单独结算一个 effect（受治理操作在完成/干净失败时调用）。
   * 已结算且带收据 = 幂等返回（不重复写账本）。
   */
  async settleEffect(
    ref: RunRef,
    effectId: string,
    outcome: "done" | "failed-clean" | "unknown",
    receipt?: EffectReceipt,
    error?: unknown,
  ): Promise<void> {
    const st = this.state(ref.runId);
    const meta = st.meta.get(effectId);
    if (!meta) {
      throw new KeelError("SCHED/NOT-FOUND", "effect not declared in this run", {
        runId: ref.runId,
        effectId,
      });
    }
    if (meta.settled && meta.receipt) return;
    await this.ledger.append(ref, "EFFECT_SETTLED", {
      effectId,
      outcome,
      ...(error !== undefined ? { error } : {}),
      ...(receipt ? { receipt } : {}),
    });
    meta.settled = true;
    if (receipt) meta.receipt = receipt;
    st.open.delete(effectId);
  }

  /**
   * 工具调用返回后的窗口结算：对本 run 仍未结的效果写 EFFECT_SETTLED。
   * status = executor 返回形；error 仅在非 ok 时附带（结果未知语义保留原始错误摘要）。
   */
  async settleFor(ref: RunRef, status: "ok" | "error" | "timeout", error?: unknown): Promise<void> {
    const st = this.state(ref.runId);
    if (st.open.size === 0) return;
    const outcome = status === "ok" ? "done" : "unknown";
    for (const effectId of [...st.open]) {
      const meta = st.meta.get(effectId);
      await this.ledger.append(ref, "EFFECT_SETTLED", {
        effectId,
        outcome,
        ...(status === "ok" ? {} : { error: error ?? null }),
      });
      if (meta) meta.settled = true;
    }
    st.open.clear();
  }

  /** 未结效果数（诊断/测试用）。 */
  openCount(runId: string): number {
    return this.runs.get(runId)?.open.size ?? 0;
  }

  /** 读 effect 元数据（测试/诊断用）。 */
  meta(runId: string, effectId: string): DeclaredEffectMeta | undefined {
    return this.runs.get(runId)?.meta.get(effectId);
  }

  private state(runId: string): RunState {
    let st = this.runs.get(runId);
    if (!st) {
      st = {
        open: new Set(),
        graph: new Map(),
        meta: new Map(),
        calls: new Map(),
      };
      this.runs.set(runId, st);
    }
    return st;
  }
}

function callKey(toolCallId: string, kind: string, targetSummary: unknown): string {
  return `${toolCallId}|${kind}|${stableKey(targetSummary)}`;
}

/** 稳定序列化（对象键排序），避免参数键序差异导致去重失效。 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`)
    .join(",")}}`;
}
