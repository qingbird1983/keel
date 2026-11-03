/**
 * 策略扩展点 —— 契约 §4.8（D1）：封闭白名单，仅此四个 hook，全部"建议/否决"型。
 *
 * - 同步调用语义：默认超时 200ms（契约 §7）；hook 失败/超时/响应违规 = 采用默认策略并记
 *   HOOK_VERDICT{fallback:true}。
 * - 响应 schema 禁区（V6）：按 hook 的封闭键集校验，顶层任何额外字段（含"下一动作/工具名/
 *   参数"类）一律拒绝 → fallback。budgetExhaustedChoice 的 action 是给定选项，不在禁区。
 * - 每次 hook 调用与裁决入账本（归因，V6）；未注册的 hook 不调用也不留痕（无介入即无事件）。
 * - 白名单封闭：新增 hook 类型必须 ADR（architecture/01 §10）。
 */

import {
  type HookCalledPayload,
  type HookName,
  type HookVerdictPayload,
  type RunRef,
} from "./events.js";
import { Ledger } from "./ledger.js";

export type HookHandler = (input: unknown) => Promise<unknown>;

/** 各 hook 的裁决形状（契约 §4.8「允许的响应」，封闭键集）。 */
export interface ToolApprovalVerdict {
  verdict: "approve" | "deny";
  reason?: string;
}
export interface StopAdviceVerdict {
  suggestStop: boolean;
  reason?: string;
}
export interface RetryAdviceVerdict {
  policy: "give-up" | "retry";
  backoffMs?: number;
}
export interface BudgetExhaustedChoiceVerdict {
  action: "hardStop" | "graceful";
}

export interface VerdictMap {
  toolApproval: ToolApprovalVerdict;
  stopAdvice: StopAdviceVerdict;
  retryAdvice: RetryAdviceVerdict;
  budgetExhaustedChoice: BudgetExhaustedChoiceVerdict;
}

/** hook 缺席/失败/超时/违规时的默认策略（fail-closed 取向）。 */
const FALLBACKS: VerdictMap = {
  // hook① 仅否决权：缺席/失败 = 不否决；Core 授权仍是硬门（契约 §4.2）
  toolApproval: { verdict: "approve" },
  stopAdvice: { suggestStop: false },
  // 无策略不自动重试
  retryAdvice: { policy: "give-up" },
  // 无策略立即停止花钱
  budgetExhaustedChoice: { action: "hardStop" },
};

const VERDICT_KEYS: Record<HookName, string[]> = {
  toolApproval: ["verdict", "reason"],
  stopAdvice: ["suggestStop", "reason"],
  retryAdvice: ["policy", "backoffMs"],
  budgetExhaustedChoice: ["action"],
};

function validateVerdict(hook: HookName, v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!VERDICT_KEYS[hook].includes(k)) return false; // 禁区：额外字段一律拒绝
  }
  switch (hook) {
    case "toolApproval":
      return (o.verdict === "approve" || o.verdict === "deny") && optString(o.reason);
    case "stopAdvice":
      return typeof o.suggestStop === "boolean" && optString(o.reason);
    case "retryAdvice":
      return (
        (o.policy === "give-up" || o.policy === "retry") &&
        optString(o.reason) &&
        optNumber(o.backoffMs)
      );
    case "budgetExhaustedChoice":
      return o.action === "hardStop" || o.action === "graceful";
  }
}

function optString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function optNumber(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

export interface HookCallResult<K extends HookName> {
  verdict: VerdictMap[K];
  fallback: boolean;
  /** 本次介入写入的账本 seq（HOOK_CALLED + HOOK_VERDICT），供 DECISION basedOn 归因。 */
  seqs: number[];
}

/**
 * 契约 §7 的插话时限（唯一来源）。切片④ ADR-0012 决策 3：宿主→策略舱的请求超时
 * **复用同一个数**，不再造第二套时限——两处都失败时走的都是本文件的 fallback 口径。
 */
export const HOOK_TIMEOUT_MS = 200;

export interface HookBusOptions {
  /** hook 超时（契约默认 200ms）；测试可调小。 */
  timeoutMs?: number;
  now?: () => number;
}

export class HookBus {
  private readonly handlers = new Map<HookName, HookHandler>();
  private readonly ledger: Ledger;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(ledger: Ledger, opts: HookBusOptions = {}) {
    this.ledger = ledger;
    this.timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 注册策略插件 handler；同名覆盖（装配器职责，运行期不换装）。 */
  register<K extends HookName>(hook: K, handler: HookHandler): void {
    this.handlers.set(hook, handler);
  }

  registered(hook: HookName): boolean {
    return this.handlers.has(hook);
  }

  /** 调用 hook 并留痕；超时/异常/响应违规一律回落默认策略（契约 §4.8 共性硬规则）。 */
  async call<K extends HookName>(
    ref: RunRef,
    hook: K,
    round: number,
    input: unknown,
  ): Promise<HookCallResult<K>> {
    const handler = this.handlers.get(hook);
    if (!handler) return { verdict: FALLBACKS[hook], fallback: true, seqs: [] };
    const called = await this.ledger.append(ref, "HOOK_CALLED", {
      hook,
      round,
    } satisfies HookCalledPayload);
    let verdict: VerdictMap[K];
    let fallback: boolean;
    try {
      const raw = await withTimeout(handler(input), this.timeoutMs);
      if (validateVerdict(hook, raw)) {
        verdict = raw as VerdictMap[K];
        fallback = false;
      } else {
        verdict = FALLBACKS[hook]; // schema 层面拒绝（V6 禁区）
        fallback = true;
      }
    } catch {
      verdict = FALLBACKS[hook]; // 超时或 handler 抛出
      fallback = true;
    }
    const recorded = await this.ledger.append(ref, "HOOK_VERDICT", {
      hook,
      round,
      verdict,
      fallback,
    } satisfies HookVerdictPayload);
    return { verdict, fallback, seqs: [called.seq, recorded.seq] };
  }
}

function withTimeout(p: Promise<unknown>, ms: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hook timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
