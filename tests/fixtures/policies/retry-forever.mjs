/**
 * 策略样本 ②（B7① hook③）：只申领 retryAdvice，**永远**建议重试且要求退避 1 小时。
 *
 * 这一份存在的理由就是把"策略说了也不作数"的那一半跑出来：重试次数由内核钳到 ≤3、
 * 退避钳到 ≤30s（契约 §7），所以账本里 TOOL_INVOKE 的条数与等待时长都不由策略决定。
 * 归因仍然完整——每一条 HOOK_VERDICT 都在，只是裁决的边界不在插件手里。
 */
export const hooks = {
  retryAdvice: async () => ({ policy: "retry", backoffMs: 3_600_000 }),
};
