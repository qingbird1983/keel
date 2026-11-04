/**
 * 会话预算的账本投影（Phase 5 切片② R7，01 稿 §3.4）。
 *
 * 口径：`Σ BUDGET_SETTLED.actual` + **有预扣但没有结算**的 `estimate`（崩溃漏账的
 * 保守上界）——不让新进程把会话已花的钱忘掉。
 */

import type { BudgetReservedPayload, BudgetSettledPayload, SessionEvent } from "@keel/core";

export function projectSessionBudget(events: readonly SessionEvent[]): number {
  const reserved = new Map<string, number>();
  const settled = new Set<string>();
  let used = 0;
  for (const { event } of events) {
    switch (event.type) {
      case "BUDGET_RESERVED": {
        const p = event.payload as BudgetReservedPayload;
        reserved.set(p.reservationId, p.estimate);
        break;
      }
      case "BUDGET_SETTLED": {
        const p = event.payload as BudgetSettledPayload;
        settled.add(p.reservationId);
        used += p.actual;
        break;
      }
      default:
        break;
    }
  }
  for (const [id, estimate] of reserved) {
    if (!settled.has(id)) used += estimate;
  }
  return used;
}
