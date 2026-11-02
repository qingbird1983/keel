/**
 * 旧模块形状归一化单测（02 稿 §4：承接层只认形状，不改代码、不猜形状）。
 */

import { describe, expect, it } from "vitest";
import { CordisAdapterError, type CordisCtx } from "../src/index.js";
import { normalizeLegacyModule } from "../src/legacy-shape.js";

const fakeCtx = { tools: {} } as unknown as CordisCtx;

describe("normalizeLegacyModule", () => {
  it("形状 1：module.exports = function activate(ctx)", () => {
    let got: unknown = null;
    const mod = { default: (ctx: CordisCtx) => (got = ctx) }; // CJS 函数导出经 ESM 装载即 default
    normalizeLegacyModule(mod)(fakeCtx);
    expect(got).toBe(fakeCtx);
  });

  it("形状 2：module.exports = { activate(ctx) }", () => {
    let called = 0;
    const mod = { default: { activate: () => called++ } };
    normalizeLegacyModule(mod)(fakeCtx);
    expect(called).toBe(1);
  });

  it("形状 3：ESM export default function(ctx)", () => {
    let got: unknown = null;
    normalizeLegacyModule({ default: (ctx: CordisCtx) => (got = ctx) })(fakeCtx);
    expect(got).toBe(fakeCtx);
  });

  it("顶层对象（无 default 包装，如同进程直接传模块对象）也可识别", () => {
    let got: unknown = null;
    normalizeLegacyModule((ctx: CordisCtx) => (got = ctx))(fakeCtx);
    expect(got).toBe(fakeCtx);
  });

  it("激活函数返回 Promise 时等待它（注册动作在 activation 边界前完成）", async () => {
    let done = false;
    const activate = normalizeLegacyModule({
      default: async () => {
        await Promise.resolve();
        done = true;
      },
    });
    await activate(fakeCtx);
    expect(done).toBe(true);
  });

  it("认不出的形状 → ADAPTER/ENTRY-UNKNOWN（不猜「第一个函数」，猜错就是静默改变插件行为）", () => {
    expect(() => normalizeLegacyModule({ default: { start: () => 1 } })).toThrowError(
      CordisAdapterError,
    );
    expect(() => normalizeLegacyModule({ default: { start: () => 1 } })).toThrowError(
      /ADAPTER\/ENTRY-UNKNOWN/,
    );
    expect(() => normalizeLegacyModule(null)).toThrowError(/got null/);
    expect(() => normalizeLegacyModule({})).toThrowError(/ADAPTER\/ENTRY-UNKNOWN/);
  });
});
