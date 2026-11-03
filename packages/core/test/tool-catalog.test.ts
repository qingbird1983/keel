import { describe, expect, it } from "vitest";
import { PageStore } from "../src/page-store.js";
import { ToolCatalog } from "../src/tool-catalog.js";
import type { RunRef } from "../src/events.js";

const scope = { agentId: "a", sessionId: "s" };
const run: RunRef = { ...scope, runId: "r1" };

describe("ToolCatalog / PageStore 拆分（ADR-0017）", () => {
  it("工具目录与页存储互不依赖；同一 Run 可同时使用", () => {
    const tools = new ToolCatalog();
    const pages = new PageStore();
    tools.alloc(scope);
    tools.registerTool(scope, { name: "t", schemaVersion: 1, schema: {} });
    const out = pages.pageOut(run, "p", { v: 1 });
    expect(tools.discover(run).map((t) => t.name)).toEqual(["t"]);
    expect(out.version).toBe(1);
    expect(pages.pageIn(run, "p").state).toEqual({ v: 1 });
  });

  it("PageStore 的页按 Run 隔离（runId 不同互不可见）", () => {
    const pages = new PageStore();
    pages.pageOut(run, "p", { mine: true });
    const other: RunRef = { ...scope, runId: "r2" };
    expect(() => pages.pageIn(other, "p")).toThrowError(/PAGE-MISSING/);
  });
});
