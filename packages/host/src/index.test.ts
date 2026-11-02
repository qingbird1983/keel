import { describe, expect, it } from "vitest";
import * as mod from "./index.js";

// 脚手架冒烟：验证包可解析、可导入（test 门禁全链路依赖此路径）
describe("@keel/host", () => {
  it("module loads", () => {
    expect(mod).toBeTypeOf("object");
  });
});
