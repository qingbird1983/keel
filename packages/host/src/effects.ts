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
 */

import { KeelError, type Ledger, type RunRef } from "@keel/core";

export class EffectTracker {
  private readonly ledger: Ledger;
  /** runId → 未结 effectId 集合（同 run 工具调用严格串行，集合即当前调用窗口）。 */
  private readonly open = new Map<string, Set<string>>();
  /** runId → (effectId → dependsOn)（声明序依赖图，成环校验用）。 */
  private readonly graph = new Map<string, Map<string, string[]>>();

  constructor(deps: { ledger: Ledger }) {
    this.ledger = deps.ledger;
  }

  /** declareEffect 落账后登记（未结）。 */
  declared(ref: RunRef, effectId: string, dependsOn: string[]): void {
    this.openSet(ref.runId).add(effectId);
    this.dependencyGraph(ref.runId).set(effectId, [...dependsOn]);
  }

  /** 声明期 dependsOn 校验：引用必须全部是本 run 已声明的效果，且不构成环。 */
  validateDependency(ref: RunRef, effectId: string, dependsOn: string[]): void {
    const g = this.dependencyGraph(ref.runId);
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
   * 工具调用返回后的窗口结算：对本 run 全部未结效果写 EFFECT_SETTLED。
   * status = executor 返回形；error 仅在非 ok 时附带（结果未知语义保留原始错误摘要）。
   */
  async settleFor(ref: RunRef, status: "ok" | "error" | "timeout", error?: unknown): Promise<void> {
    const ids = this.open.get(ref.runId);
    if (!ids || ids.size === 0) return;
    const outcome = status === "ok" ? "done" : "unknown";
    for (const effectId of ids) {
      await this.ledger.append(ref, "EFFECT_SETTLED", {
        effectId,
        outcome,
        ...(status === "ok" ? {} : { error: error ?? null }),
      });
    }
    ids.clear();
  }

  /** 未结效果数（诊断/测试用）。 */
  openCount(runId: string): number {
    return this.open.get(runId)?.size ?? 0;
  }

  private openSet(runId: string): Set<string> {
    let s = this.open.get(runId);
    if (!s) {
      s = new Set();
      this.open.set(runId, s);
    }
    return s;
  }

  private dependencyGraph(runId: string): Map<string, string[]> {
    let g = this.graph.get(runId);
    if (!g) {
      g = new Map();
      this.graph.set(runId, g);
    }
    return g;
  }
}
