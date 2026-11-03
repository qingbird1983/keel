/**
 * 治理切面（AOP）—— 类型、字段选择与摘要（04 稿 §4.4/4.5，ADR-0015）。
 *
 * 切面声明在 manifest（`governance.tools[]`），由宿主编译成计划随 bootstrap 送达；
 * 本模块只做 Cell 侧的执行辅助：从 params 取声明字段、算可复现摘要、拼守卫资源。
 * **不读 manifest 文件、不复制授权规则**——守卫仍然问内核 Authorizer。
 */

import { createHash } from "node:crypto";
import { ChannelError } from "./protocol.js";

export interface GovernanceGuardPlan {
  /** v1 仅文件系统能力（net.fetch 需主机名归一，另案）。 */
  cap: "fs.read" | "fs.write";
  /** params 顶层字段名；值必须是字符串。 */
  from: string;
  /** 资源前缀；fs.* 必须显式写 `fs:`（不设魔法默认）。 */
  prefix?: string;
}

export interface GovernanceEffectPlan {
  /** 必须命中 manifest compensation.templates[].kind（宿主装配期已校验，内核再做 C-M1）。 */
  kind: string;
  /** 进入 targetSummary 的顶层字段（明文）。 */
  targetFields: string[];
  /** 进入 paramsDigest 的顶层字段（只出摘要）；缺省 = 无摘要。 */
  digestFields?: string[];
}

export interface GovernedToolPlan {
  guard?: GovernanceGuardPlan;
  effects?: GovernanceEffectPlan[];
}

/** 宿主 → Cell 的治理计划（`bootstrapExtra.governance`）。 */
export interface CellGovernancePlan {
  version: 1;
  tools: Record<string, GovernedToolPlan>;
}

/** 框架已声明的效果（handler 只读视图；effectId 可用于外部幂等键）。 */
export interface DeclaredEffectView {
  readonly kind: string;
  readonly effectId: string;
  readonly seq: number;
  readonly targetSummary: unknown;
  readonly paramsDigest?: { alg: "sha256"; hex: string };
}

/** 空效果视图（无治理声明的工具共用同一冻结实例）。 */
export const EMPTY_EFFECTS: readonly DeclaredEffectView[] = Object.freeze([]);

function badField(purpose: string, field: string, detail: string): never {
  throw new ChannelError("TRANSPORT/BADFRAME", `governance ${purpose}: ${detail}`, { field });
}

/** 按 manifest 声明的顶层字段名取值；缺字段/非对象一律 BADFRAME（handler 不执行）。 */
export function pickFields(params: unknown, fields: readonly string[], purpose: string): unknown {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    badField(purpose, fields[0] ?? "params", "tool params must be an object");
  }
  const src = params as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.hasOwn(src, field)) badField(purpose, field, `missing field "${field}"`);
    picked[field] = src[field];
  }
  return picked;
}

/** 守卫资源 = prefix + params[from]；字段必须是字符串（fail-closed）。 */
export function guardResource(guard: GovernanceGuardPlan, params: unknown): string {
  const picked = pickFields(params, [guard.from], "guard resource") as Record<string, unknown>;
  const raw = picked[guard.from];
  if (typeof raw !== "string" || raw.length === 0) {
    badField("guard resource", guard.from, `field "${guard.from}" must be a non-empty string`);
  }
  return `${guard.prefix ?? ""}${raw}`;
}

/** 键排序 JSON（递归）——跨进程可复现的摘要输入。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/** 固定算法：选中字段对象 → 键排序 JSON → SHA-256（输出 {alg,hex}）。 */
export function canonicalDigest(input: unknown): { alg: "sha256"; hex: string } {
  const hex = createHash("sha256").update(canonicalJson(input)).digest("hex");
  return { alg: "sha256", hex };
}
