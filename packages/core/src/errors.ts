/**
 * 错误码与错误类型 —— 契约 §6 完整表（分域字符串 DOMAIN/KIND，封闭集合）。
 */

export const ERROR_CODES = [
  "AUTH/DENIED",
  "AUTH/SCOPE-UNKNOWN",
  "CTX/SCOPE-UNKNOWN",
  "CTX/SCOPE-EXISTS",
  "SCHED/NOT-FOUND",
  "BUDGET/EXHAUSTED",
  "BUDGET/RESERVATION-UNKNOWN",
  "BUDGET/INVALID-LIMIT",
  "LEDGER/CURSOR-INVALID",
  "LEDGER/WRITE-FAILED",
  "RECOVER/RUN-UNKNOWN",
  "RECOVER/SNAPSHOT-MISSING",
  "RECOVER/COMPENSATION-FAILED",
  "SCHED/BACKPRESSURE",
  "SCHED/MANIFEST-INVALID",
  "GATEWAY/UPSTREAM-ERROR",
  "CTX/PAGE-MISSING",
  "TRANSPORT/TIMEOUT",
  "TRANSPORT/BADFRAME",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Keel 统一错误：一切错误必须带契约错误码（standards/04 §2 显式分类）。 */
export class KeelError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "KeelError";
    this.code = code;
    this.detail = detail;
  }
}
