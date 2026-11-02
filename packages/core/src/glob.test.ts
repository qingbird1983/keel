import { describe, expect, it } from "vitest";
import { globMatch } from "./glob.js";

describe("globMatch（allow 限定符方言）", () => {
  it("`*` 段内匹配，不跨 `/`", () => {
    expect(globMatch("fs:/data/*.csv", "fs:/data/a.csv")).toBe(true);
    expect(globMatch("fs:/data/*.csv", "fs:/data/sub/a.csv")).toBe(false);
  });

  it("`**` 尾段匹配任意余串", () => {
    expect(globMatch("fs:/data/**", "fs:/data/a/b/c.txt")).toBe(true);
    expect(globMatch("fs:/data/**", "fs:/data/")).toBe(true);
    expect(globMatch("fs:/data/**", "fs:/other/x")).toBe(false);
  });

  it("`**` 中段匹配零或多个完整段", () => {
    expect(globMatch("fs:/a/**/b", "fs:/a/b")).toBe(true);
    expect(globMatch("fs:/a/**/b", "fs:/a/x/y/b")).toBe(true);
    expect(globMatch("fs:/a/**/b", "fs:/a/x/b/y")).toBe(false);
  });

  it("`?` 单字符；正则元字符按字面处理", () => {
    expect(globMatch("fs:/a?c", "fs:/abc")).toBe(true);
    expect(globMatch("fs:/a?c", "fs:/abbc")).toBe(false);
    expect(globMatch("fs:/a.b", "fs:/axb")).toBe(false);
    expect(globMatch("fs:/a.b", "fs:/a.b")).toBe(true);
  });
});
