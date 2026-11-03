/**
 * 承接层宿主端口与承接面单测 —— 口径见 docs/design/phase-2/02 §3、§6（原型口径 05 稿已被其取代）。
 *
 * 三条重点：
 * 1. 旧 `ctx.tools.*` 的形状（含位置形与对象形两种调用）都落在 Core 的 scope 分区，**承接层不自存表**；
 * 2. 方法一律 async（跨进程问内核的诚实形状），错误**以拒绝的承诺浮现**而不是吞掉；
 * 3. 未映射的旧面逐项抛 `ADAPTER/UNSUPPORTED`，且与 `CORDIS_SURFACE` 常量逐项对照——
 *    常量与实现漂移 = B5 符号闭环失去依据，所以这条用循环核对而不是手写九个 expect。
 */

import { describe, expect, it } from "vitest";
import { ContextManager, KeelError, type RunRef } from "@keel/core";
import {
  CORDIS_SURFACE,
  CordisAdapterError,
  createCordisCtx,
  createCordisCellCtx,
  hostRegistryPort,
  type CordisCtx,
} from "../src/index.js";
import * as mod from "../src/index.js";

const refA: RunRef = { agentId: "agent-1", sessionId: "sess-a", runId: "run-a" };
const refB: RunRef = { agentId: "agent-1", sessionId: "sess-b", runId: "run-b" };

function rig(): { ctx: ContextManager; a: CordisCtx; b: CordisCtx } {
  const ctx = new ContextManager();
  ctx.alloc({ agentId: refA.agentId, sessionId: refA.sessionId });
  ctx.alloc({ agentId: refB.agentId, sessionId: refB.sessionId });
  return { ctx, a: createCordisCtx({ ctx, ref: refA }), b: createCordisCtx({ ctx, ref: refB }) };
}

/** 取回承接面上某个点号的调用体（"share.get" → ctx.share.get）。 */
function faceOf(ctx: CordisCtx, path: string): (...args: unknown[]) => unknown {
  let cur: unknown = ctx;
  for (const key of path.split(".")) cur = (cur as Record<string, unknown>)[key];
  if (typeof cur !== "function") throw new Error(`surface path is not callable: ${path}`);
  return cur as (...args: unknown[]) => unknown;
}

describe("模块面（承接层导出）", () => {
  it("工厂 + 错误类 + 端口 + 承接面常量齐备", () => {
    expect(createCordisCtx).toBeTypeOf("function");
    expect(createCordisCellCtx).toBeTypeOf("function");
    expect(hostRegistryPort).toBeTypeOf("function");
    expect(CordisAdapterError).toBeTypeOf("function");
    expect(mod).toBeTypeOf("object");
  });

  it("承接面常量自洽：mapped / refused / withheld / guide 四集互不重叠（B5 对照表的地基）", () => {
    const all = [
      ...CORDIS_SURFACE.mapped,
      ...CORDIS_SURFACE.refused,
      ...CORDIS_SURFACE.withheld,
      ...CORDIS_SURFACE.guide,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("改法地面单列一桶，不混进 mapped（混进去 = 把 C 档谎报成 A 档，B5 一票否决的漂移形态）", () => {
    for (const face of CORDIS_SURFACE.guide) {
      expect(CORDIS_SURFACE.mapped).not.toContain(face);
      expect(CORDIS_SURFACE.refused).not.toContain(face);
    }
    expect([...CORDIS_SURFACE.guide].sort()).toEqual([
      "effects.declare",
      "ledger.read",
      "model.invoke",
    ]);
  });
});

describe("宿主端口：ctx.tools.* → scope 注册（async 形状）", () => {
  it("注册即本 scope 可见；同名重复 = 版本 +1（覆盖语义映射）", async () => {
    const { ctx, a } = rig();
    await expect(
      a.tools.register({ name: "web.fetch", schema: { type: "object" }, handler: () => 1 }),
    ).resolves.toEqual({ name: "web.fetch", schemaVersion: 1 });
    await expect(a.tools.register({ name: "web.fetch" })).resolves.toMatchObject({
      schemaVersion: 2,
    });
    expect(ctx.discover(refA).map((t) => `${t.name}@${t.schemaVersion}`)).toEqual(["web.fetch@2"]);
  });

  it("旧框架位置形 register(name, schema, handler) 与对象形等价", async () => {
    const { a } = rig();
    const positional = await a.tools.register("pos", { p: 1 }, () => 1);
    const object = await a.tools.register({ name: "obj", schema: { p: 1 }, handler: () => 1 });
    expect([positional, object]).toEqual([
      { name: "pos", schemaVersion: 1 },
      { name: "obj", schemaVersion: 1 },
    ]);
  });

  it("list 只回本 scope（V1：旧写法迁入后仍看不到邻居的表）", async () => {
    const { a, b } = rig();
    await a.tools.register({ name: "only-a" });
    await b.tools.register({ name: "only-b" });
    expect(await a.tools.list()).toEqual([{ name: "only-a", schemaVersion: 1 }]);
    expect((await b.tools.list()).map((t) => t.name)).toEqual(["only-b"]);
  });

  it("remove 返回是否真实存在；下线后不可见", async () => {
    const { ctx, a } = rig();
    await a.tools.register({ name: "temp" });
    expect(await a.tools.remove("temp")).toBe(true);
    expect(await a.tools.remove("temp")).toBe(false);
    expect(ctx.discover(refA)).toEqual([]);
  });

  it("同名条目按 scope 各记各的版本（全局表污染在这里结构上不可能）", async () => {
    const { a, b } = rig();
    await a.tools.register({ name: "shared" }); // a → v1
    await b.tools.register({ name: "shared" }); // b → v1（不是 a 的 v2）
    await a.tools.register({ name: "shared" }); // a → v2，b 不受扰动
    expect(await a.tools.list()).toEqual([{ name: "shared", schemaVersion: 2 }]);
    expect(await b.tools.list()).toEqual([{ name: "shared", schemaVersion: 1 }]);
  });

  it("宿主端口丢弃 handler（宿主持有插件执行体没有意义）——可见而不可执行是它的既定边界", async () => {
    const { ctx, a } = rig();
    let called = 0;
    await a.tools.register({ name: "shadow", handler: () => called++ });
    expect(ctx.discover(refA)[0]).not.toHaveProperty("handler");
    expect(called).toBe(0);
  });
});

describe("有损边界（显式报错，不静默降级）", () => {
  it("无作用域绑定 / 缺 Core 绑定 → ADAPTER/SCOPE-REQUIRED（拒绝构造「全局视图」）", () => {
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

  it("空工具名 → 拒绝的承诺（async 面里错误也必须可见，不许悄悄返回成功）", async () => {
    const { a } = rig();
    await expect(a.tools.register({ name: "" })).rejects.toThrowError(/tool name required/);
    await expect(a.tools.register("   ")).rejects.toThrowError(/tool name required/);
  });

  it("逐项核对：CORDIS_SURFACE.refused 的每个旧面调用都抛 ADAPTER/UNSUPPORTED", () => {
    const { a } = rig();
    for (const path of CORDIS_SURFACE.refused) {
      expect(() => faceOf(a, path)("x", {})).toThrowError(/ADAPTER\/UNSUPPORTED/);
    }
  });

  it("拒绝信息带改法去处（「不能这么写」必须配「这么写也能达到目的」；切片③ 起去处有地面可指）", () => {
    const { a } = rig();
    expect(() => a.share.get("k")).toThrowError(/ctx\.ledger\.read|tool-call params/);
    expect(() => a.effects.reclaim("e1")).toThrowError(/ctx\.effects\.declare|compensation/);
    expect(() => a.hooks.register("beforeTool")).toThrowError(/whitelist/);
    expect(() => a.bus.emit("topic")).toThrowError(/tool-call params/);
    expect(() => a.llm.chat({ q: 1 })).toThrowError(/ctx\.model\.invoke|gateway/);
    // #4 切片② 改判 C 后文案不得再写 "B 档"（F9：文案滞后就是归因滞后）
    expect(() => a.config.get("SECRET")).toThrowError(/边界 #4, C 档/);
  });

  it("作用域自省不提供：读取 ctx.scope 的任何字段即抛（不是 undefined）", () => {
    const { a } = rig();
    const scope = a.scope as unknown as Record<string, unknown>;
    expect(() => scope.runId).toThrowError(/ADAPTER\/UNSUPPORTED/);
  });

  it("作用域未分配：Core 的 CTX/SCOPE-UNKNOWN 原样浮出（承接层不擅自 alloc）", async () => {
    const ctx = new ContextManager();
    const orphan = createCordisCtx({ ctx, ref: refA });
    await expect(orphan.tools.register({ name: "x" })).rejects.toBeInstanceOf(KeelError);
    await expect(orphan.tools.list()).rejects.toThrowError(/SCOPE-UNKNOWN/);
  });
});
