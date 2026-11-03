/**
 * 策略样本（装载期拒绝）：报关单只申领了 `toolApproval`，模块却多导出一个 `stopAdvice`。
 *
 * 这是"未申领就插话"的形态（01 稿 #14 的正面），拒绝发生在**装载期**：
 * `normalizePolicyHooks` 核对导出集合 ≠ 声明集合 → 进程直接退出 → 宿主的一次就绪探测
 * 拿不到应答 = `TRANSPORT/TIMEOUT` + `reason:"CELL_NOT_READY"`（ADR-0011 同一姿态，不新增错误码）。
 * 于是"两张皮"的策略根本起不来，而不是"接上能用的那几个"。
 */
export const hooks = {
  toolApproval: async () => ({ verdict: "approve" }),
  stopAdvice: async () => ({ suggestStop: false }),
};
