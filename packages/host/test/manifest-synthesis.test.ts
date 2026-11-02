/**
 * 声明合成（切片②）——"观察账本 → 候选报关单"的投影规则与**不完备性口径**。
 *
 * 这一份测试守的不只是产出正确，还有产出**诚实**：合不出来的东西必须留在缺项清单里，
 * 候选不能因为"看起来能过校验"就假装覆盖了插件的全部调用面（03 稿 §4、§12 限制 1）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "@keel/core";
import { Assembler, BOUNDARY_CAPS } from "../src/assembler.js";
import {
  OBSERVED_ACTION_CAPS,
  contractRange,
  synthesizeManifest,
  synthesizeName,
} from "../src/manifest-synthesis.js";

const schema = JSON.parse(
  readFileSync(path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json"), "utf-8"),
);

function ev(type: string, payload: Record<string, unknown>, seq = 1): LedgerEvent {
  return {
    seq,
    ts: 0,
    runId: "run-obs",
    sessionId: "s",
    agentId: "a",
    type: type as LedgerEvent["type"],
    schemaVersion: 1,
    payload,
  };
}

const deniedRegister = (name: string, seq: number): LedgerEvent =>
  ev("AUTH_DENIED", { subject: "agent-a", action: "tool.register", resource: name }, seq);

describe("合成候选的内容与确定性", () => {
  it("注册被拒的名字集合就是候选的 allow：去重、排序，两次产出字节相同", () => {
    const events = [
      deniedRegister("zeta", 1),
      deniedRegister("echo", 2),
      deniedRegister("zeta", 3),
      deniedRegister("alpha", 4),
    ];
    const a = synthesizeManifest({
      events,
      pluginFile: "tierA-01-toolset.cjs",
      observedRunIds: ["r1"],
    });
    const b = synthesizeManifest({
      events: [...events].reverse(),
      pluginFile: "tierA-01-toolset.cjs",
      observedRunIds: ["r1"],
    });
    expect(a.raw.permissions).toEqual([{ cap: "tool.provide", allow: ["alpha", "echo", "zeta"] }]);
    expect(a.toolNames).toEqual(["alpha", "echo", "zeta"]);
    expect(JSON.stringify(a.raw)).toBe(JSON.stringify(b.raw)); // 可 diff、可复核
  });

  it("成功注册（TOOL_SCHEMA_CHANGED）与撤名（newSchemaVersion=0）都算 tool.provide 的证据", () => {
    const events = [
      ev("TOOL_SCHEMA_CHANGED", { tool: "boot", newSchemaVersion: 1 }),
      ev("TOOL_SCHEMA_CHANGED", { tool: "late", newSchemaVersion: 2 }),
      ev("TOOL_SCHEMA_CHANGED", { tool: "boot", newSchemaVersion: 0 }),
      deniedRegister("late", 4),
    ];
    const r = synthesizeManifest({ events, pluginFile: "x.cjs", observedRunIds: ["r"] });
    expect(r.raw.permissions).toEqual([{ cap: "tool.provide", allow: ["boot", "late"] }]);
  });

  it("词表外的 action 不产声明：没有对应 cap 的观察事实就不该进报关单", () => {
    const events = [
      ev("AUTH_DENIED", { action: "budget.query", resource: "*" }),
      ev("AUTH_DENIED", { action: "ledger.read", resource: "other-run" }),
      ev("AUTH_DENIED", { action: "memory.write", resource: "mem:1" }), // 词表有 cap 但无对应 op
    ];
    const r = synthesizeManifest({ events, pluginFile: "x.cjs", observedRunIds: ["r"] });
    expect(r.raw.permissions).toEqual([]);
    expect(OBSERVED_ACTION_CAPS["memory.read"]).toBeUndefined();
  });

  it("候选直接过五步校验（只含 tool.provide 的情形）", () => {
    const r = synthesizeManifest({
      events: [deniedRegister("echo", 1)],
      pluginFile: "tierA-01-toolset.cjs",
      observedRunIds: ["obs-1", "obs-2"],
    });
    const loaded = new Assembler({ schema }).assemble(r.raw);
    expect(loaded.permissions).toEqual([{ cap: "tool.provide", allow: ["echo"] }]);
    expect(loaded.meta.version).toBe("0.0.0"); // 合成版本不是发布版本
    expect(loaded.compat.keelContract).toBe(contractRange());
    expect(loaded.record.manifest.name).toBe("legacy-tiera-01-toolset");
  });

  it("名字规范化：大写 / 多扩展名 / 非法字符 / 数字开头都得落在 schema 允许的形态里", () => {
    expect(synthesizeName("Foo.Bar-plugin.cjs")).toBe("legacy-foo-bar-plugin");
    expect(synthesizeName("0427x.mjs")).toBe("legacy-x");
    expect(synthesizeName("/abs/path/my_plugin.ts")).toBe("legacy-my-plugin");
    expect(synthesizeName("")).toBe("legacy-plugin");
  });
});

describe("合成不完备性的显式登记（缺项清单）", () => {
  it("越界能力 → 缺补偿模板，且候选的模板池保持空（绝不代造）", () => {
    const r = synthesizeManifest({
      events: [
        ev("AUTH_DENIED", { action: "net.fetch", resource: "api.example.com" }),
        ev("AUTH_DENIED", { action: "fs.write", resource: "/tmp/out*" }),
      ],
      pluginFile: "x.cjs",
      observedRunIds: ["r"],
    });
    expect(r.caps).toEqual(["net.fetch", "fs.write"]);
    expect(r.raw.compensation).toEqual({ templates: [] });
    const codes = r.gaps.filter((g) => g.code === "COMPENSATION_TEMPLATE_REQUIRED");
    expect(codes).toHaveLength(2);
    expect(BOUNDARY_CAPS.has("net.fetch")).toBe(true);
    // 五步校验第 2 步据此把它拒掉——这正是"缺项没被假装补齐"的证据
    expect(() => new Assembler({ schema }).assemble(r.raw)).toThrow(/compensation template/i);
  });

  it("固定缺项两条：不经通道的调用面观察不到 + 超时取自宿主默认值", () => {
    const r = synthesizeManifest({ events: [], pluginFile: "x.cjs", observedRunIds: [] });
    const codes = r.gaps.map((g) => g.code);
    expect(codes).toContain("UNOBSERVABLE_NATIVE_IO");
    expect(codes).toContain("TOOL_CALL_TIMEOUT_UNKNOWN");
    const desc = (r.raw.meta as { description: string }).description;
    expect(desc).toContain("synthesized from observation");
  });

  it("handler 没跑通 = 覆盖度事实，进缺项而不是被忽略", () => {
    const r = synthesizeManifest({
      events: [
        ev("TOOL_RESULT", { tool: "needsParams", status: "error" }),
        ev("TOOL_RESULT", { tool: "slow", status: "timeout" }),
        ev("TOOL_RESULT", { tool: "fine", status: "ok" }),
      ],
      pluginFile: "x.cjs",
      observedRunIds: ["r"],
    });
    const notCovered = r.gaps.filter((g) => g.code === "HANDLER_NOT_COVERED");
    expect(notCovered).toHaveLength(2);
    expect(notCovered.map((g) => g.detail).join(" ")).toContain("needsParams");
    expect(notCovered.map((g) => g.detail).join(" ")).not.toContain("fine");
  });

  it("缺项按种类排序（报告可读、可比对）", () => {
    const r = synthesizeManifest({
      events: [
        ev("AUTH_DENIED", { action: "fs.write", resource: "/tmp/a*" }),
        ev("TOOL_RESULT", { tool: "t", status: "timeout" }),
      ],
      pluginFile: "x.cjs",
      observedRunIds: ["r"],
    });
    const codes = r.gaps.map((g) => g.code);
    expect(codes).toEqual([...codes].sort());
  });
});
