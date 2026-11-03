/**
 * 插件 B `file-write` 单元测试（对齐插件 A D3 口径：handler 直测，零进程）。
 * 收据 / 补偿 / 账本留痕的端到端走根 tests/native-file-write-e2e.test.ts（真进程）。
 */

import { describe, expect, it } from "vitest";
import * as mod from "../src/index.js";

const tools = mod.tools;

describe("插件 B file-write：导出面与 handler 行为", () => {
  it("恰一个工具、名字 write_file、schema 声明 path/content 必填", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("write_file");
    expect(tools[0]?.schema).toMatchObject({
      type: "object",
      required: ["path", "content"],
      additionalProperties: false,
    });
  });

  it("handler 走 ctx.workspace.create，返回 {path, bytes}；不碰 fs、不写撤销代码", async () => {
    const calls: { path: string; content: string }[] = [];
    const t = tools[0]!;
    const out = await t.handler(
      { path: "a.txt", content: "keel" },
      {
        workspace: {
          create: async (args) => {
            calls.push(args);
            return { bytes: 4 };
          },
        },
      },
    );
    expect(out).toEqual({ path: "a.txt", bytes: 4 });
    expect(calls).toEqual([{ path: "a.txt", content: "keel" }]);
  });

  it("无状态导出面：模块只导出 tools（无 setup/dispose 需求 = 无资源 Cell）", () => {
    expect(Object.keys(mod).sort()).toEqual(["tools"]);
  });
});
