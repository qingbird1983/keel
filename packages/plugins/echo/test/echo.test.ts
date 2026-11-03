/**
 * 插件 A `echo` 单元测试（03 稿 D3：包内轻量单测，handler 直测，零进程）。
 * 授权/发现/隔离的端到端走根 tests/native-echo-e2e.test.ts（真进程）。
 */

import { describe, expect, it } from "vitest";
import * as mod from "../src/index.js";

const tools = mod.tools;

describe("插件 A echo：导出面与 handler 行为", () => {
  it("恰一个工具、名字 echo、schema 声明 text 必填", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("echo");
    expect(tools[0]?.schema).toMatchObject({
      type: "object",
      required: ["text"],
      additionalProperties: false,
    });
  });

  it("handler 原样返回输入文本（{echoed} 形，与 TOOL_RESULT.resultDigest 断言形状一致）", () => {
    const t = tools[0]!;
    expect(t.handler({ text: "hello keel" })).toEqual({ echoed: "hello keel" });
    expect(t.handler({ text: "" })).toEqual({ echoed: "" });
  });

  it("无状态导出面：模块只导出 tools（无 snapshot/compensations/migrate = 无状态 Cell）", () => {
    expect(Object.keys(mod).sort()).toEqual(["tools"]);
  });
});
