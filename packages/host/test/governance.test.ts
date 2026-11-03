import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Assembler, type LoadedManifest } from "../src/assembler.js";
import { compileGovernancePlan } from "../src/governance.js";

const schema = JSON.parse(
  readFileSync(path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json"), "utf-8"),
);

function load(raw: Record<string, unknown>): LoadedManifest {
  return new Assembler({ schema }).assemble(raw);
}

function governed(): Record<string, unknown> {
  return {
    kind: "capability",
    meta: { name: "file-writer", version: "0.1.0", title: "F", description: "d" },
    permissions: [{ cap: "fs.write", allow: ["/tmp/keel-workspace/**"] }],
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: {
      templates: [
        {
          kind: "fs.write.done",
          class: "reversible",
          action: { type: "builtin", ref: "fs.remove" },
          idempotency: "natural",
        },
      ],
    },
    compat: { keelContract: "^1.0" },
    governance: {
      tools: [
        {
          name: "write_file",
          guard: { cap: "fs.write", from: "path", prefix: "fs:" },
          effects: [
            { kind: "fs.write.done", targetFields: ["path"], digestFields: ["path", "content"] },
          ],
        },
      ],
    },
  };
}

describe("compileGovernancePlan：manifest → Cell 计划（ADR-0015）", () => {
  it("无声明 → null（spawn 载荷形状不变）", () => {
    const raw = governed();
    delete raw.governance;
    expect(compileGovernancePlan(load(raw).governance)).toBeNull();
  });

  it("有声明 → version=1、按工具名索引、不含宿主私有面", () => {
    const plan = compileGovernancePlan(load(governed()).governance);
    expect(plan).toEqual({
      version: 1,
      tools: {
        write_file: {
          guard: { cap: "fs.write", from: "path", prefix: "fs:" },
          effects: [
            { kind: "fs.write.done", targetFields: ["path"], digestFields: ["path", "content"] },
          ],
        },
      },
    });
    expect(JSON.stringify(plan)).not.toContain("permissions");
  });

  it("计划与 manifest 解耦（改计划不回头改报关单）", () => {
    const loaded = load(governed());
    const plan = compileGovernancePlan(loaded.governance);
    plan!.tools.write_file.effects![0].targetFields.push("content");
    expect(loaded.governance?.[0].effects?.[0].targetFields).toEqual(["path"]);
  });
});
