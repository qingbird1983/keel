/**
 * permission-rules 单测 —— manifest 声明 → 运行期授权规则（ADR-0010 决策 6，切片①）。
 * 口径：只编译**已有跨通道 op** 的词表项；没有 op 的项不产出规则（声明 ≠ 能力）；
 * 未声明 = 无规则 = 默认拒绝（I4）。`tool.invoke`（Core→Cell 方向的执行裁决）不在此列——
 * 那是宿主策略输入既有内容，本片不擅自扩它。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Assembler, type LoadedManifest } from "../src/assembler.js";
import { manifestAuthRules } from "../src/permission-rules.js";

const schema = JSON.parse(
  readFileSync(path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json"), "utf-8"),
);

function load(raw: Record<string, unknown>): LoadedManifest {
  return new Assembler({ schema }).assemble(raw);
}

function capability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "capability",
    meta: { name: "plug-a", version: "1.2.0", title: "A", description: "test plugin" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
    ...overrides,
  };
}

describe("permission-rules：封闭词表接进运行期裁决", () => {
  it("tool.provide（无 allow）→ tool.register + tool.remove，resource = *", () => {
    expect(manifestAuthRules(load(capability()), "cell-1")).toEqual([
      { subject: "cell-1", action: "tool.register", resource: "*" },
      { subject: "cell-1", action: "tool.remove", resource: "*" },
    ]);
  });

  it("tool.provide 带 allow → 逐条收窄工具名（glob 原样进规则）", () => {
    const rules = manifestAuthRules(
      load(
        capability({ permissions: [{ cap: "tool.provide", allow: ["search.*", "exact-one"] }] }),
      ),
      "s",
    );
    expect(rules.map((r) => r.action)).toEqual([
      "tool.register",
      "tool.register",
      "tool.remove",
      "tool.remove",
    ]);
    expect(rules.map((r) => r.resource)).toEqual([
      "search.*",
      "exact-one",
      "search.*",
      "exact-one",
    ]);
  });

  it("model.adapter → model.invoke；net/fs 三项按各自 action 产出", () => {
    const rules = manifestAuthRules(
      load(
        capability({
          permissions: [
            { cap: "model.adapter" },
            { cap: "net.fetch", allow: ["api.example.com"] },
            { cap: "fs.read", allow: ["fs:/data/**/*.csv"] },
            { cap: "fs.write", allow: ["fs:/tmp/**"] },
          ],
          compensation: {
            templates: [
              {
                kind: "fs.write.done",
                class: "reversible",
                action: { type: "plugin", ref: "compensations/undo" },
                idempotency: "natural",
              },
            ],
          },
        }),
      ),
      "cell-9",
    );
    expect(rules.map((r) => `${r.action}|${r.resource}`)).toEqual([
      "model.invoke|*",
      "net.fetch|api.example.com",
      "fs.read|fs:/data/**/*.csv",
      "fs.write|fs:/tmp/**",
    ]);
    expect(rules.every((r) => r.subject === "cell-9")).toBe(true);
  });

  it("memory.backend 无对应运行期 op → 不产出规则（声明不等于能力）", () => {
    const rules = manifestAuthRules(
      load(
        capability({
          permissions: [{ cap: "memory.backend", allow: ["mem:user-1"] }],
          compensation: {
            templates: [
              {
                kind: "memory.write",
                class: "record-only",
                action: { type: "builtin", ref: "noop" },
                idempotency: "natural",
              },
            ],
          },
        }),
      ),
      "s",
    );
    expect(rules).toEqual([]);
  });

  it("未声明任何能力 → 空规则（默认拒绝：auth.check 会拒并留痕）", () => {
    expect(manifestAuthRules(load(capability({ permissions: [] })), "s")).toEqual([]);
  });

  it("规则形态即 Authorizer 的 allow 条目（subject × action × resource 三元）", () => {
    const rules = manifestAuthRules(load(capability()), "c");
    expect(rules.every((r) => Object.keys(r).sort().join(",") === "action,resource,subject")).toBe(
      true,
    );
  });
});
