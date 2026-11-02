// A4 fixture：工具声明越界效果后自身失败（结果未知 → 保守补偿路径）；
// compensations 表由宿主补偿执行器经一次性新补偿 Cell 进程分发（切片④）。
// effectKind 必须命中 manifest 模板（C-M1）；补偿 actionRef 以模板为准（声明不可临场编造）。
// 切片⑤桩组收全：always-slow（超时分类）/ dedup-keyed（真实去重）/ mitigate（缓解）+ dependsOn 透传。

export const tools = [
  {
    name: "fail-with-effect",
    schema: {},
    handler: async (params, { client }) => {
      await client.declareEffect({
        effectKind: params.effectKind,
        targetSummary: { target: params.target ?? "ext-1" },
        compensation: { actionRef: "ignored-template-wins", idempotency: "keyed" },
        dependsOn: Array.isArray(params.dependsOn) ? params.dependsOn : undefined,
      });
      throw new Error("boom-after-declare");
    },
  },
];

// keyed 去重桩：按 effectId 记真实调用次数——重派无害的端到端证明（目标系统侧去重）
const dedupSeen = new Map();

export const compensations = {
  undo: async () => ({ undone: true }),
  "always-fail": async () => {
    throw new Error("compensation upstream down");
  },
  // 恒慢桩：睡眠远超补偿通道超时 → 宿主侧超时分类（error/timeout → 重试/升级路径）
  "always-slow": async () => {
    await new Promise((r) => setTimeout(r, 30_000));
    return { undone: true };
  },
  "dedup-keyed": async (input) => {
    const n = (dedupSeen.get(input.effectId) ?? 0) + 1;
    dedupSeen.set(input.effectId, n);
    return { dedup: true, effectId: input.effectId, calls: n };
  },
  mitigate: async () => ({ mitigated: true }),
  // record-only 模板无需 handler：宿主执行器直闭（审计留痕 + 告警）
};
