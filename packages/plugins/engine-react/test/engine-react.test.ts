import { describe, expect, it } from "vitest";
import { snapshot, step, type EngineDeclView } from "../src/index.js";

const engine: EngineDeclView = {
  loop: "react",
  model: { ref: "model-mock", name: "mock-chat" },
  tools: ["echo"],
  maxSteps: 3,
};

function ctx(result: unknown) {
  return {
    engine,
    client: {
      modelInvoke: async (req: { reqId: string }) => ({ result, reqId: req.reqId }),
    },
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  runId: "run-unit",
  step: 1,
  maxSteps: 3,
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [{ name: "echo", schemaVersion: 1, schema: {} }],
  ...over,
});

describe("engine-react（Phase 4 切片④）", () => {
  it("工具调用意图 → act；模型正文与 usageRef 回给 Core 写表面事件", async () => {
    const out = await step(
      input(),
      ctx({
        content: "",
        reasoningContent: "need tool",
        toolCalls: [{ id: "c1", name: "echo", arguments: { text: "x" } }],
      }),
    );
    expect(out.decision).toEqual({
      kind: "act",
      actions: [{ tool: "echo", params: { text: "x" }, toolCallId: "c1" }],
    });
    expect(out.message).toMatchObject({
      content: "",
      reasoningContent: "need tool",
      usageRef: { reqId: "run-unit:1" },
    });
  });

  it("没有工具调用 → done；OpenAI 形状（function.name / JSON 字符串参数）也能归一", async () => {
    const out = await step(
      input({ step: 2 }),
      ctx({
        content: "finished",
        toolCalls: [{ id: "c2", function: { name: "echo", arguments: '{"text":"y"}' } }],
      }),
    );
    expect(out.decision).toEqual({
      kind: "act",
      actions: [{ tool: "echo", params: { text: "y" }, toolCallId: "c2" }],
    });
    const done = await step(input({ step: 2 }), ctx({ content: "finished" }));
    expect(done.decision).toEqual({ kind: "done", summary: "finished" });
  });

  it("缺报关单声明 / 超 maxSteps = 明确失败（不猜语义）", async () => {
    await expect(
      step(input(), { engine: undefined, client: { modelInvoke: async () => ({}) } }),
    ).rejects.toThrow(/engine declaration missing/);
    await expect(step(input({ step: 4 }), ctx({ content: "x" }))).rejects.toThrow(
      /exceeds maxSteps/,
    );
  });

  it("快照只证明跑在子进程；无权威状态", () => {
    expect(snapshot()).toMatchObject({ pid: process.pid, kind: "engine-react" });
  });
});
