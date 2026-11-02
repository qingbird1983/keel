// A4 fixture：工具声明越界效果后自身失败（结果未知 → 保守补偿路径）；
// compensations 表由宿主补偿执行器经一次性新补偿 Cell 进程分发（切片④）。
// effectKind 必须命中 manifest 模板（C-M1）；补偿 actionRef 以模板为准（声明不可临场编造）。

export const tools = [
  {
    name: "fail-with-effect",
    schema: {},
    handler: async (params, { client }) => {
      await client.declareEffect({
        effectKind: params.effectKind,
        targetSummary: { target: params.target ?? "ext-1" },
        compensation: { actionRef: "ignored-template-wins", idempotency: "keyed" },
      });
      throw new Error("boom-after-declare");
    },
  },
];

export const compensations = {
  undo: async () => ({ undone: true }),
  "always-fail": async () => {
    throw new Error("compensation upstream down");
  },
  // record-only 模板无需 handler：宿主执行器直闭（审计留痕 + 告警）
};
