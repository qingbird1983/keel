/**
 * 授权器 —— 契约 §4.2：白名单 + 默认拒绝（fail-closed，standards/06 §4）。
 * 拒绝必写 AUTH_DENIED 事件（拒绝留痕）；允许不写事件（契约 §5 无 AUTH_GRANTED）。
 * 策略插件不参与裁决——审批类需求走 hook①，且仅"否决权"无"授予权"。
 */

import { globMatch } from "./glob.js";
import { Ledger } from "./ledger.js";
import type { RunRef } from "./events.js";

/** 一条允许规则；`*` 全匹配，资源支持 glob（`**` 跨段 / `*` 段内）。 */
export interface AuthRule {
  subject: string;
  action: string;
  resource: string;
}

export interface AuthPolicyInput {
  version: string;
  allow: AuthRule[];
}

export interface AuthDecision {
  allowed: boolean;
  /** 拒绝时的归因说明（同时入 AUTH_DENIED 事件）。 */
  reason?: string;
}

function fieldMatches(pattern: string, value: string): boolean {
  return pattern === "*" || pattern === value || globMatch(pattern, value);
}

export class Authorizer {
  private readonly policy: AuthPolicyInput;
  private readonly ledger: Ledger;

  constructor(policy: AuthPolicyInput, ledger: Ledger) {
    this.policy = policy;
    this.ledger = ledger;
  }

  /** 当前生效授权策略版本（契约 auth.policy.get，诊断只读）。 */
  get version(): string {
    return this.policy.version;
  }

  /** 判定 subject × action × resource；拒绝时写 AUTH_DENIED 并返回决策。 */
  async check(
    ref: RunRef,
    subject: string,
    action: string,
    resource: string,
  ): Promise<AuthDecision> {
    const rule = this.policy.allow.find(
      (r) =>
        fieldMatches(r.subject, subject) &&
        fieldMatches(r.action, action) &&
        fieldMatches(r.resource, resource),
    );
    if (rule) return { allowed: true };
    const reason = `no allow rule matches ${subject} × ${action} × ${resource} (policy ${this.policy.version})`;
    await this.ledger.append(ref, "AUTH_DENIED", {
      subject,
      action,
      resource,
      policyVersion: this.policy.version,
      reason,
    });
    return { allowed: false, reason };
  }
}
