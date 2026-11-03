/**
 * 策略样本 ③（B7① hook④）：只申领 budgetExhaustedChoice，一律选 `graceful`。
 *
 * 入参带本 run 的预算视图（06 稿 §9 第 5 条登记的后果：策略因此**读得到**预算，
 * 但这属 hook 入参，不构成新的读面）。选完之后的终态仍由内核落：
 * graceful → 完成在途动作后 RUN_HALTED{BUDGET/EXHAUSTED-GRACEFUL}。
 */
export const hooks = {
  budgetExhaustedChoice: async () => ({ action: "graceful" }),
};
