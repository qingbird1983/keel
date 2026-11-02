import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateSchema } from "../src/schema-validator.js";

/** manifest 稿 §7 CI 义务：Schema 与两示例即 fixtures（防 Schema 与文档漂移）。 */
const SCHEMA_PATH = path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json");
const EXAMPLES = [
  "docs/design/phase-1/schema/examples/capability-webfetch.json",
  "docs/design/phase-1/schema/examples/policy-budget-guard.json",
];

describe("关键词子集校验器", () => {
  it("两示例过 keel-plugin.schema.json（A5 结构主张）", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
    for (const p of EXAMPLES) {
      const manifest = JSON.parse(readFileSync(path.resolve(p), "utf-8"));
      expect(validateSchema(schema, manifest), p).toEqual([]);
    }
  });

  it.each([
    ["type", { type: "integer" }, "x", /expected type/],
    ["required", { type: "object", required: ["a"] }, {}, /missing required/],
    [
      "additionalProperties",
      { type: "object", additionalProperties: false, properties: {} },
      { x: 1 },
      /unexpected additional/,
    ],
    ["enum", { enum: ["a", "b"] }, "c", /expected one of/],
    ["const", { const: 1 }, 2, /expected const/],
    ["pattern", { type: "string", pattern: "^a+$" }, "bbb", /pattern/],
    ["minLength", { type: "string", minLength: 2 }, "a", /minLength/],
    ["maxLength", { type: "string", maxLength: 1 }, "abc", /maxLength/],
    ["minimum", { type: "integer", minimum: 3 }, 2, /minimum/],
    ["maximum", { type: "integer", maximum: 3 }, 4, /maximum/],
    ["minItems", { type: "array", minItems: 1 }, [], /minItems/],
    ["maxItems", { type: "array", maxItems: 0 }, [1], /maxItems/],
    ["maxProperties", { type: "object", maxProperties: 0 }, { a: 1 }, /maxProperties/],
    ["integer 非整", { type: "integer" }, 1.5, /expected type/],
  ])("%s 负路径", (_k, schema, value, matches) => {
    const issues = validateSchema(schema as object, value);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(matches as RegExp);
  });

  it("items 对每个元素报路径；allOf 全部施加；if 通过才施加 then", () => {
    expect(validateSchema({ type: "array", items: { type: "string" } }, ["a", 1])).toEqual([
      { path: "/1", message: "expected type string" },
    ]);
    expect(
      validateSchema({ allOf: [{ type: "string" }, { pattern: "^a" }] }, "bc").map(
        (i) => i.message,
      ),
    ).toEqual(["does not match pattern ^a"]);
    // if 不满足 → then 不施加
    expect(validateSchema({ if: { const: 1 }, then: { const: 2 } }, 5)).toEqual([]);
    // if 满足 → then 施加
    expect(validateSchema({ if: { const: 1 }, then: { const: 2 } }, 1)).toHaveLength(1);
  });

  it("集合外关键词直接报错（防 Schema 演进后静默漏检）", () => {
    const issues = validateSchema({ type: "string", exclusiveMinimum: 1 }, "x");
    expect(issues[0].message).toContain("unsupported schema keywords");
  });

  it("嵌套路径可归因", () => {
    const schema = {
      type: "object",
      properties: { res: { type: "object", properties: { ms: { type: "integer", minimum: 1 } } } },
    };
    expect(validateSchema(schema, { res: { ms: 0 } })).toEqual([
      { path: "/res/ms", message: "below minimum 1" },
    ]);
  });
});
