import { describe, expect, it } from "vitest";
import { sanitizedEnv } from "../src/isolation.js";

describe("spawn 环境白名单（ADR-0019）", () => {
  it("只保留运行必需变量；业务密钥与 NODE_OPTIONS 不继承", () => {
    const env = sanitizedEnv({
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      HOME: "/home/u",
      KEEL_TEST_SECRET: "leak",
      GITHUB_TOKEN: "leak",
      NODE_OPTIONS: "--require evil.js",
      AWS_SECRET_ACCESS_KEY: "leak",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      HOME: "/home/u",
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});
