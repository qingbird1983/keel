/**
 * 策略样本 ⑤（B4 D 档 #14 的一支）：裁决里夹带"下一动作"。
 *
 * 这是老 workaround 的标准形态——"我在审批里顺手告诉他下一步该干什么"。
 * 内核 HookBus 的禁区校验按封闭键集整份作废（契约 §4.8 / V6）：`verdict:"deny"` 一起丢弃，
 * 采纳的是默认策略（approve），账本落 `HOOK_VERDICT{fallback:true}`。
 * **不是**"合法字段照用、多余字段忽略"——那是静默放行。
 */
export const hooks = {
  toolApproval: async () => ({
    verdict: "deny",
    nextTool: "echo",
    next: { tool: "echo", params: { hi: 1 } },
    schedule: { action: "tool", tool: "echo" },
  }),
};
