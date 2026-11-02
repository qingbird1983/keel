/**
 * Cordis Adapter 原型单测 —— 口径见 docs/design/phase-1/05：
 * 旧 `ctx.tools.register()` 形状必须落在 Core 的 scope 分区上（无全局表、无自存状态），
 * 映射不到的旧语义显式报错而非静默降级。
 */

import { describe, expect, it } from "vitest";
import { ContextManager, KeelError, type RunRef } from "@keel/core";
import { CordisAdapterError, createCordisCtx } from "../src/index.js";
import * as mod from "../src/index.js";

const refA: RunRef = { agentId: "agent-1", sessionId: "sess-a", runId: "run-a" };
const refB: RunRef = { agentId: "agent-1", sessionId: "sess-b", runId: "run-b" };

function rig(): {
  ctx: ContextManager;
  a: ReturnType<typeof createCordisCtx>;
  b: ReturnType<typeof createCordisCtx>;
} {
  const ctx = new ContextManager();
  ctx.alloc(refA);
  ctx.alloc(refB);
  return { ctx, a: createCordisCtx({ ctx, ref: refA }), b: createCordisCtx({ ctx, ref: refB }) };
}

describe("@keel/cordis-adapter（模块面）", () => {
  it("可导入且导出面齐（工厂 + 错误类）", () => {
    expect(mod).toBeTypeOf("object");
    expect(createCordisCtx).toBeTypeOf("function");
    expect(CordisAdapterError).toBeTypeOf("function");
  });
});

describe("ctx.tools.* → scope 注册（映射成立）", () => {
  it("注册即本 scope 可见；同名重复 = 版本 +1（覆盖语义映射）", () => {
    const { ctx, a } = rig();
    expect(
      a.tools.register({ name: "web.fetch", schema: { type: "object" }, handler: () => 1 }),
    ).toEqual({ name: "web.fetch", schemaVersion: 1 });
    expect(a.tools.register({ name: "web.fetch" })).toMatchObject({ schemaVersion: 2 });
    expect(ctx.discover(refA).map((t) => `${t.name}@${t.schemaVersion}`)).toEqual(["web.fetch@2"]);
  });

  it("list 只回本 scope（V1：旧写法迁入后仍看不到邻居的表）", () => {
    const { a, b } = rig();
    a.tools.register({ name: "only-a" });
    b.tools.register({ name: "only-b" });
    expect(a.tools.list().map((t) => t.name)).toEqual(["only-a"]);
    expect(b.tools.list().map((t) => t.name)).toEqual(["only-b"]);
  });

  it("remove 返回是否真实存在；下线后不可见", () => {
    const { ctx, a } = rig();
    a.tools.register({ name: "temp" });
    expect(a.tools.remove("temp")).toBe(true);
    expect(a.tools.remove("temp")).toBe(false);
    expect(ctx.discover(refA)).toEqual([]);
  });

  it("同名条目按 scope 各记各的版本（全局表污染在这里结构上不可能）", () => {
    const { a, b } = rig();
    a.tools.register({ name: "shared" }); // a → v1
    b.tools.register({ name: "shared" }); // b → v1（不是 a 的 v2）
    a.tools.register({ name: "shared" }); // a → v2，b 不受扰动
    expect(a.tools.list()).toEqual([{ name: "shared", schemaVersion: 2 }]);
    expect(b.tools.list()).toEqual([{ name: "shared", schemaVersion: 1 }]);
  });
});

describe("有损边界（显式报错，不静默降级）", () => {
  it("无作用域绑定即创建 → ADAPTER/SCOPE-REQUIRED", () => {
    const { ctx } = rig();
    expect(() => createCordisCtx({ ctx, ref: undefined as unknown as RunRef })).toThrowError(
      /ADAPTER\/SCOPE-REQUIRED/,
    );
    expect(() => createCordisCtx({ ctx, ref: { ...refA, sessionId: "" } })).toThrowError(
      CordisAdapterError,
    );
    expect(() =>
      createCordisCtx({ ctx: undefined as unknown as ContextManager, ref: refA }),
    ).toThrowError(/ContextManager/);
  });

  it("空工具名 → ADAPTER/SCOPE-REQUIRED（注册形状本身不完整）", () => {
    const { a } = rig();
    expect(() => a.tools.register({ name: "" })).toThrowError(/tool name required/);
  });

  it("共享 Context 与 effect 回收 → ADAPTER/UNSUPPORTED（Phase 2 承接）", () => {
    const { a } = rig();
    expect(() => a.share.get("k")).toThrowError(/ADAPTER\/UNSUPPORTED/);
    expect(() => a.share.set("k", 1)).toThrowError(/read-only injection/);
    expect(() => a.effects.reclaim("e1")).toThrowError(/compensation declaration/);
  });

  it("作用域未分配：Core 的 CTX/SCOPE-UNKNOWN 原样抛出（适配器不擅自 alloc）", () => {
    const ctx = new ContextManager();
    const orphan = createCordisCtx({ ctx, ref: refA });
    expect(() => orphan.tools.register({ name: "x" })).toThrowError(KeelError);
    expect(() => orphan.tools.list()).toThrowError(/SCOPE-UNKNOWN/);
  });
});
