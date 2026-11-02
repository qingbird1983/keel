import { describe, expect, it } from "vitest";
import * as mod from "../src/index.js";

describe("@keel/core", () => {
  it("公共出口暴露核心组件与契约常量", () => {
    expect(mod.Ledger).toBeTypeOf("function");
    expect(mod.Authorizer).toBeTypeOf("function");
    expect(mod.Budgeter).toBeTypeOf("function");
    expect(mod.EVENT_TYPES).toContain("CHECKPOINT");
    expect(mod.EVENT_TYPES).toContain("COMPENSATION_WAIVED");
    expect(mod.ERROR_CODES).toContain("BUDGET/EXHAUSTED");
  });
});
