/**
 * 会话 e2e 的确定性模型（Phase 5 切片②）：把"它看到了多少条历史"写进回答正文。
 *
 * E1 的证据链：run2 的模型视图里应包含 run1 的用户输入 / 模型回答 / 工具结果，
 * 所以回答正文从 `seen users=1 tools=0` 变成 `seen users=2 tools=1`。
 * 不读环境、不出网、不依赖时钟（禁面规则与 model-mock 同口径）。
 */

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

export function create() {
  return {
    async invoke(req) {
      const params = req?.params ?? {};
      const messages = Array.isArray(params.messages) ? params.messages : [];
      // 压缩摘要（Phase 5 切片④）：确定性正文 = "summary of N messages"。
      if (params.purpose === "compaction") {
        return {
          result: { role: "assistant", content: `summary of ${messages.length} messages` },
          usage: { inputCached: 0, inputUncached: messages.length, output: 3 },
        };
      }
      const users = messages.filter((m) => m && m.role === "user").length;
      const tools = messages.filter((m) => m && m.role === "tool").length;
      const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
      let plan;
      try {
        plan = JSON.parse(typeof lastUser?.content === "string" ? lastUser.content : "{}");
      } catch {
        plan = {};
      }
      if (!plan || typeof plan !== "object") plan = {};
      const usage = { inputCached: 0, inputUncached: 10, output: 5 };
      // 崩溃用例：工具已执行、第二次模型调用挂住——杀进程就落在"已写、还在想"的窗口。
      if (plan.delayMs && tools > 0) await sleep(plan.delayMs);
      if (plan.tool && tools === 0) {
        return {
          result: {
            role: "assistant",
            content: "",
            reasoningContent: "need a tool",
            toolCalls: [
              { id: `call-${params.step ?? 1}`, name: plan.tool, arguments: plan.arguments ?? {} },
            ],
          },
          usage,
        };
      }
      return {
        result: {
          role: "assistant",
          content: `seen users=${users} tools=${tools}`,
          reasoningContent: "done",
        },
        usage,
      };
    },
  };
}
