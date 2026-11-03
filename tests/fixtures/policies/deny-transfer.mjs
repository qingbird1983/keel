/**
 * 策略样本 ①（B7① hook①）：只申领 toolApproval，对 `transfer` 一律否决。
 *
 * 形状纪律：策略模块**只导出 `hooks`**，且导出的键集必须与报关单声明完全相等
 * （`normalizePolicyHooks` 在装载期核对，两张皮不起舱）。入参只有内核给的那一份
 * （`{tool, paramsDigest}`），没有句柄、没有主动接口（契约 §3.3）。
 */
export const hooks = {
  toolApproval: async (input) => {
    const tool = input && input.tool;
    return tool === "transfer"
      ? { verdict: "deny", reason: "policy: transfers need a human" }
      : { verdict: "approve" };
  },
};
