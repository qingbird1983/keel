/**
 * 插件 C `param-guard`（Phase 3 三件套，08 稿 §6.3）——策略插件：按参数内容模式否决 write_file。
 *
 * 零 import（扫描判据 B4-deps）；唯一导出 = `export const hooks`（policy-hooks 口径：
 * 导出键集必须与报关单声明完全相等）。策略只插话不接管：唯一动作 = 否决权
 * （`toolApproval` hook①，契约 §4.8），不改写参数、不替插件重试、无任何自带 IO。
 *
 * 拦截面选内容模式（08 稿 §6.3）：装配 allow / governance guard 只看 `path`，内容模式是
 * 它们结构上看不到的面——避免把"策略拦截"与"守卫拒绝"混成一条证据（C4 口径）。
 * `paramsDigest` 字段在 toolApproval 通道承载明文 params（契约既有形状，不在本片改名）。
 */

/** 被拦内容模式：write_file 的 content 含此子串即否决。 */
const BLOCKED_PATTERN = "TOPSECRET";

type ToolApprovalInput = { tool: string; paramsDigest: unknown };
type ToolApprovalVerdict = { verdict: "approve" | "deny"; reason?: string };

export const hooks = {
  toolApproval: (input: unknown): ToolApprovalVerdict => {
    const { tool, paramsDigest } = (input ?? {}) as ToolApprovalInput;
    const params = paramsDigest as { content?: unknown } | null;
    if (
      tool === "write_file" &&
      typeof params?.content === "string" &&
      params.content.includes(BLOCKED_PATTERN)
    ) {
      return {
        verdict: "deny",
        reason: `policy: content matches blocked pattern ${BLOCKED_PATTERN}`,
      };
    }
    return { verdict: "approve" };
  },
};
