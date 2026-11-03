/**
 * 策略样本 ④（B7① hook②）：只申领 stopAdvice，看到决策摘要里带 `policy-stop` 就建议收束。
 *
 * 为什么按"driver 说了什么"而不是按轮号：装载屏障本身会吃掉若干轮（真实子进程起飞要时间），
 * 轮号在测试里不是稳定量——而 hook② 的入参本来就是 `{round, summary}`，
 * 按摘要内容判断才是这个插话点的正当用法。
 *
 * 注意"建议"二字的分量：内核采纳与否是 Core 的裁决（MVP 采纳），插件不能自己 `return done`
 * ——终态事件 RUN_HALTED{reason:"stop-advised"} 由内核写。
 */
export const hooks = {
  stopAdvice: async (input) => {
    const stop = String((input && input.summary) || "").includes("policy-stop");
    return stop
      ? { suggestStop: true, reason: "policy: the driver asked to wind down" }
      : { suggestStop: false };
  },
};
