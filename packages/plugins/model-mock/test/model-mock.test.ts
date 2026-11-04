import { describe, expect, it } from "vitest";
import { create, USAGE_PER_CHUNK, type MockModelSection } from "../src/index.js";

const model: MockModelSection = {
  provider: "mock",
  protocol: "mock",
  models: ["mock-chat"],
  auth: { ref: "KEEL_MODEL_MOCK_KEY" },
  timeouts: { idleMs: 20 },
};

const upstream = create({ model, secrets: { resolve: () => "fake" } });

describe("model-mock 剧本（Phase 4 切片③）", () => {
  it("非流式：只报三桶用量，不自报费用", async () => {
    const out = await upstream.invoke({ model: "mock-chat", params: {} });
    expect(out.usage).toEqual(USAGE_PER_CHUNK);
    expect(out.result).toMatchObject({ role: "assistant", content: "mock answer" });
    expect("cost" in out).toBe(false);
  });

  it("reasoningContent 按调用方给的正文回传（表面消息硬字段）", async () => {
    const out = await upstream.invoke({
      model: "mock-chat",
      params: { content: "hi", reasoningContent: "thought" },
    });
    expect(out.result).toMatchObject({ content: "hi", reasoningContent: "thought" });
  });

  it("throw / no-usage 剧本可确定复现", async () => {
    await expect(
      upstream.invoke({ model: "mock-chat", params: { scenario: "throw" } }),
    ).rejects.toThrow(/mock upstream failure/);
    const out = await upstream.invoke({ model: "mock-chat", params: { scenario: "no-usage" } });
    expect(out.usage).toBeUndefined();
  });

  it("流式：逐片累计三桶（末片即终值），模块不带费用字段", async () => {
    const parts = [];
    for await (const part of upstream.stream({ model: "mock-chat", params: { chunks: 3 } })) {
      parts.push(part);
    }
    expect(parts).toHaveLength(3);
    expect(parts[0]!.chunk).toEqual({ seq: 1, text: "mock-1" });
    expect(parts[2]!.usage).toEqual({
      inputCached: USAGE_PER_CHUNK.inputCached * 3,
      inputUncached: USAGE_PER_CHUNK.inputUncached * 3,
      output: USAGE_PER_CHUNK.output * 3,
    });
    expect(parts.every((p) => !("cost" in p))).toBe(true);
  });

  it("空闲看门狗：停顿超过 manifest idleMs 即中止（不再假装还在等）", async () => {
    const started = Date.now();
    const gen = upstream.stream({
      model: "mock-chat",
      params: { chunks: 3, pauseAfterFirstMs: 500 },
    });
    const first = await gen.next();
    expect(first.value?.chunk).toEqual({ seq: 1, text: "mock-1" });
    await expect(gen.next()).rejects.toThrow(/idle watchdog fired/);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("ReAct 模式：按用户计划先给工具调用意图，有工具结果后收束", async () => {
    const plan = {
      role: "user",
      content: JSON.stringify({ tool: "echo", arguments: { text: "hi" }, final: "done" }),
    };
    const first = await upstream.invoke({
      model: "mock-chat",
      params: { messages: [plan], step: 1 },
    });
    expect(first.result).toMatchObject({
      content: "",
      toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hi" } }],
    });
    const second = await upstream.invoke({
      model: "mock-chat",
      params: { messages: [plan, { role: "tool", content: "{}", toolCallId: "call-1" }], step: 2 },
    });
    expect(second.result).toMatchObject({ content: "done", reasoningContent: "enough context" });
    expect((second.result as { toolCalls?: unknown }).toolCalls).toBeUndefined();
  });

  it("断流剧本：先出 N 片再抛（已产出部分可对账）", async () => {
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const part of upstream.stream({
          model: "mock-chat",
          params: { chunks: 5, chunksBeforeThrow: 2 },
        })) {
          seen.push(part.chunk);
        }
      })(),
    ).rejects.toThrow(/died mid-stream/);
    expect(seen).toHaveLength(2);
  });
});
