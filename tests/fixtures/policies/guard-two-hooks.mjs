/**
 * 策略样本 ⑥（CLI 交付入口用）：与 Phase 1 的正样例报关单
 * `docs/design/phase-1/schema/examples/policy-budget-guard.json`（hooks = toolApproval +
 * budgetExhaustedChoice）**逐名对齐**——装载期核对导出集合 = 声明集合，多一个少一个都不起舱。
 *
 * 这份存在的目的是把 `keel run --policy-manifest … --policy-module …` 这条路跑成真东西：
 * 报关单里的代码路径字段不存在（声明不指定实现），所以模块路径由宿主配置给（06 稿 §3.1 第 5 步）。
 */
export const hooks = {
  toolApproval: async (input) =>
    input && input.tool === "blocked"
      ? { verdict: "deny", reason: "budget-guard: this tool needs a human" }
      : { verdict: "approve" },
  budgetExhaustedChoice: async () => ({ action: "graceful" }),
};
