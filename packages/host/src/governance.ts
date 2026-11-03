/**
 * 宿主侧治理计划编译（04 稿 §4.3，ADR-0015）。
 *
 * manifest 的 `governance.tools[]` 在装配期已完成结构/语义校验；这里只做纯映射：
 * 数组 → 按工具名索引的计划，补 `version`，不带任何宿主私货（权限、身份、账本面都不进舱）。
 */

import type { CellGovernancePlan, GovernedToolPlan } from "@keel/cell-runtime";
import type { GovernanceToolDecl } from "./assembler.js";

/** 无治理声明 = null（spawn 载荷形状与今天一致）。 */
export function compileGovernancePlan(
  tools: readonly GovernanceToolDecl[] | null | undefined,
): CellGovernancePlan | null {
  if (!tools || tools.length === 0) return null;
  const byName: Record<string, GovernedToolPlan> = Object.create(null) as Record<
    string,
    GovernedToolPlan
  >;
  for (const tool of tools) {
    byName[tool.name] = {
      ...(tool.guard
        ? {
            guard: {
              cap: tool.guard.cap,
              from: tool.guard.from,
              ...(tool.guard.prefix !== undefined ? { prefix: tool.guard.prefix } : {}),
            },
          }
        : {}),
      ...(tool.effects
        ? {
            effects: tool.effects.map((e) => ({
              kind: e.kind,
              targetFields: [...e.targetFields],
              ...(e.digestFields ? { digestFields: [...e.digestFields] } : {}),
            })),
          }
        : {}),
    };
  }
  return { version: 1, tools: byName };
}
