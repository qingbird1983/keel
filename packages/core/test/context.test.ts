import { describe, expect, it } from "vitest";
import { ContextManager } from "../src/context.js";
import { KeelError } from "../src/errors.js";
import type { RunRef } from "../src/events.js";

const scopeA = { agentId: "agent-1", sessionId: "sess-a" };
const scopeB = { agentId: "agent-1", sessionId: "sess-b" };
const runA1: RunRef = { ...scopeA, runId: "run-a1" };
const runA2: RunRef = { ...scopeA, runId: "run-a2" };
const runB1: RunRef = { ...scopeB, runId: "run-b1" };

describe("ContextManager（V1 / I5：按 scope 分区）", () => {
  it("alloc 幂等：重复 alloc 不重建分区，已注册工具保留", () => {
    const cm = new ContextManager();
    cm.alloc(scopeA);
    cm.registerTool(scopeA, { name: "t1", schemaVersion: 1, schema: {} });
    cm.alloc(scopeA);
    expect(cm.discover(runA1)).toHaveLength(1);
    expect(cm.hasScope(scopeA)).toBe(true);
    expect(cm.hasScope(scopeB)).toBe(false);
  });

  it("未分配 scope：discover / registerTool 报 CTX/SCOPE-UNKNOWN（无隐式全局注册）", () => {
    const cm = new ContextManager();
    expect(() => cm.discover(runB1)).toThrowError(KeelError);
    expect(() => cm.discover(runB1)).toThrowError(
      expect.objectContaining({ code: "CTX/SCOPE-UNKNOWN" }),
    );
    expect(() => cm.registerTool(scopeB, { name: "t", schemaVersion: 1, schema: {} })).toThrowError(
      expect.objectContaining({ code: "CTX/SCOPE-UNKNOWN" }),
    );
  });

  it("scope 互不可见：A 注册的工具 B discover 不到（A1 结构性防御）", () => {
    const cm = new ContextManager();
    cm.alloc(scopeA);
    cm.alloc(scopeB);
    cm.registerTool(scopeA, { name: "only-a", schemaVersion: 1, schema: { x: 1 } });
    expect(cm.discover(runA1).map((t) => t.name)).toEqual(["only-a"]);
    expect(cm.discover(runB1)).toEqual([]);
  });

  it("TOOL_SCHEMA_CHANGED 仅传播到受影响 scope；同 scope 多 run 游标独立不丢事件", () => {
    const cm = new ContextManager();
    cm.alloc(scopeA);
    cm.alloc(scopeB);
    cm.registerTool(scopeA, { name: "t1", schemaVersion: 1, schema: {} });
    cm.registerTool(scopeA, { name: "t1", schemaVersion: 2, schema: { v: 2 } });
    // B scope 无任何挂起变更
    expect(cm.consumeSchemaChanges(runB1)).toEqual([]);
    // A scope 的 run-a1 拿到两条变更
    const forA1 = cm.consumeSchemaChanges(runA1);
    expect(forA1).toEqual([
      { tool: "t1", oldSchemaVersion: 0, newSchemaVersion: 1, affectedScope: scopeA },
      { tool: "t1", oldSchemaVersion: 1, newSchemaVersion: 2, affectedScope: scopeA },
    ]);
    // 同 scope 的 run-a2（游标独立）仍能拿到全部变更；run-a1 再取为空
    expect(cm.consumeSchemaChanges(runA2)).toHaveLength(2);
    expect(cm.consumeSchemaChanges(runA1)).toEqual([]);
  });

  it("removeTool：变更载荷 newSchemaVersion=0，discover 不再返回", () => {
    const cm = new ContextManager();
    cm.alloc(scopeA);
    cm.registerTool(scopeA, { name: "t1", schemaVersion: 3, schema: {} });
    cm.removeTool(scopeA, "t1");
    expect(cm.discover(runA1)).toEqual([]);
    expect(cm.consumeSchemaChanges(runA1)).toEqual([
      { tool: "t1", oldSchemaVersion: 0, newSchemaVersion: 3, affectedScope: scopeA },
      { tool: "t1", oldSchemaVersion: 3, newSchemaVersion: 0, affectedScope: scopeA },
    ]);
  });

  it("discover 稳定排序（缓存命中稳定的前提）", () => {
    const cm = new ContextManager();
    cm.alloc(scopeA);
    for (const n of ["c", "a", "b"]) {
      cm.registerTool(scopeA, { name: n, schemaVersion: 1, schema: {} });
    }
    expect(cm.discover(runA1).map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  /* ── 换页原语（切片④，契约 context.page.out/in）───────────────────── */

  it("pageOut → pageIn：版本单调、内容往返；pageIn 已移入/不存在的页 = CTX/PAGE-MISSING", () => {
    const cm = new ContextManager();
    const v1 = cm.pageOut(runA1, "ctx", { messages: [1, 2] });
    expect(v1).toEqual({ pageId: "ctx", version: 1 });
    const back = cm.pageIn(runA1, "ctx");
    expect(back).toEqual({ pageId: "ctx", version: 1, state: { messages: [1, 2] } });
    // 已在工作集内：无可移回
    expect(() => cm.pageIn(runA1, "ctx")).toThrowError(
      expect.objectContaining({ code: "CTX/PAGE-MISSING" }),
    );
    // 不存在的页
    expect(() => cm.pageIn(runA1, "nope")).toThrowError(
      expect.objectContaining({ code: "CTX/PAGE-MISSING" }),
    );
  });

  it("重复 pageOut 版本递增且更新内容；pageVersion 诊断读取", () => {
    const cm = new ContextManager();
    cm.pageOut(runA1, "ctx", { a: 1 });
    cm.pageIn(runA1, "ctx");
    const v2 = cm.pageOut(runA1, "ctx", { a: 2 }); // 再次移出（新内容）
    expect(v2.version).toBe(2);
    expect(cm.pageVersion(runA1, "ctx")).toBe(2);
    expect(cm.pageIn(runA1, "ctx").state).toEqual({ a: 2 });
    // pageOut 无 state：保留旧内容，版本仍递增
    expect(cm.pageOut(runA1, "ctx").version).toBe(3);
    expect(cm.pageIn(runA1, "ctx").state).toEqual({ a: 2 });
    expect(() => cm.pageVersion(runA1, "nope")).toThrowError(
      expect.objectContaining({ code: "CTX/PAGE-MISSING" }),
    );
  });

  it("页按 run 隔离：runA1 的页对 runA2 不可见（I5 同构）", () => {
    const cm = new ContextManager();
    cm.pageOut(runA1, "ctx", { mine: true });
    expect(() => cm.pageIn(runA2, "ctx")).toThrowError(
      expect.objectContaining({ code: "CTX/PAGE-MISSING" }),
    );
    expect(() => cm.pageVersion(runA2, "ctx")).toThrowError(
      expect.objectContaining({ code: "CTX/PAGE-MISSING" }),
    );
  });
});
