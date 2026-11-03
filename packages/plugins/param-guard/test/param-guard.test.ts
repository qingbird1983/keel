/**
 * 插件 C `param-guard` 单元测试（handler 直测，零进程）。
 * 介入归因 / fallback / 联装的端到端走根 tests/native-param-guard-e2e.test.ts（真进程）。
 */

import { describe, expect, it } from "vitest";
import * as mod from "../src/index.js";

const hooks = mod.hooks;

describe("插件 C param-guard：导出面与裁决行为", () => {
  it("恰一个 hook、名字 toolApproval（导出键集与报关单声明完全相等）", () => {
    expect(Object.keys(hooks).sort()).toEqual(["toolApproval"]);
  });

  it("write_file + content 含 TOPSECRET → deny + reason", async () => {
    const v = await hooks.toolApproval!({
      tool: "write_file",
      paramsDigest: { path: "a.txt", content: "hello TOPSECRET world" },
    });
    expect(v).toMatchObject({ verdict: "deny", reason: expect.stringContaining("TOPSECRET") });
  });

  it("正常内容放行；其他工具同内容不误伤；非字符串 content 放行", async () => {
    expect(
      await hooks.toolApproval!({
        tool: "write_file",
        paramsDigest: { path: "a.txt", content: "ok" },
      }),
    ).toEqual({ verdict: "approve" });
    expect(
      await hooks.toolApproval!({ tool: "echo", paramsDigest: { text: "TOPSECRET" } }),
    ).toEqual({ verdict: "approve" });
    expect(
      await hooks.toolApproval!({ tool: "write_file", paramsDigest: { path: "a.txt" } }),
    ).toEqual({ verdict: "approve" });
  });

  it("无状态导出面：模块只导出 hooks（策略无工具/无资源/无补偿）", () => {
    expect(Object.keys(mod).sort()).toEqual(["hooks"]);
  });
});
