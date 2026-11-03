// [ARCHIVED 2026-11-03 per ADR-0014 实施注记 3] Cordis 兼容层测试已剥离主线门禁（vitest.config.ts exclude）。
// 文件与断言保留在仓库，可单独复跑（npx vitest run <本文件>）； Phase 3 原生插件测试接管等强度覆盖前，此处不再被 CI 保护。
/**
 * 旧插件的补偿表与快照面登记单测（切片③，04 稿 §2 F5）。
 *
 * 三条断言纪律：
 * 1. **只认形状、不造语义**：承接层把 `module.exports.compensations` / `.snapshot` 接出来，
 *    不代插件造补偿动作，也不把 `effects.reclaim()` 翻译成补偿（那是换名的静默降级）；
 * 2. **无导出 = 不登记**（而不是登记空表）：空表会让未知 actionRef 的失败形态从
 *    `CELL/ACTION-UNKNOWN`（明确未登记）变成另一种，归因就漂了；
 * 3. **坏形状在装载期就拒**：表里混进非函数值 = 回滚执行到一半才炸，那是补偿状态机最贵的场景。
 *
 * 真进程那一半（新舱真的执行到这张表）由 tests/cordis-c-surface.test.ts 的 B3 #9 覆盖。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CordisAdapterError, normalizeLegacyExtras } from "../src/index.js";

const fixtureDir = path.join(process.cwd(), "tests", "fixtures", "cordis-plugins");
const load = (name: string): Promise<unknown> =>
  import(pathToFileURL(path.join(fixtureDir, name)).href);

/** CJS 常见的"函数导出 + 挂属性"形状。 */
function cjsLikeFn(extras: Record<string, unknown>): { default: unknown } {
  const fn = Object.assign(function activate() {}, extras);
  return { default: fn };
}

describe("旧插件的附加面登记（compensations / snapshot）", () => {
  it("函数导出 + 挂属性：两张面都接出来，函数本体不受影响", () => {
    const undo = () => ({ undone: true });
    const snapshot = () => ({ phase: "p" });
    const extras = normalizeLegacyExtras(
      cjsLikeFn({ compensations: { "undo-x": undo }, snapshot }),
    );
    expect(Object.keys(extras.compensations ?? {})).toEqual(["undo-x"]);
    expect(extras.compensations?.["undo-x"]).toBe(undo);
    expect(extras.snapshot).toBe(snapshot);
  });

  it("对象导出 `{activate, compensations, snapshot}`（旧框架第二种形状）同样接出来", () => {
    const undo = () => 1;
    const extras = normalizeLegacyExtras({
      default: { activate: () => undefined, compensations: { u: undo } },
    });
    expect(extras.compensations).toEqual({ u: undo });
    expect(extras.snapshot).toBeUndefined(); // 没导出 = 没有，不是空函数
  });

  it("无任何附加面 → 空对象（**不是** `{compensations:{}}`：登记空表会改变失败形态）", async () => {
    expect(normalizeLegacyExtras({ default: function activate() {} })).toEqual({});
    const mod = await load("tierA-01-toolset.cjs");
    expect(normalizeLegacyExtras(mod).compensations).toBeUndefined();
    expect(normalizeLegacyExtras(mod).snapshot).toBeUndefined();
  });

  it("真实样本：tierC-09-declare.cjs 的表与快照面被原样接出来（动作名由报关单给）", async () => {
    const extras = normalizeLegacyExtras(await load("tierC-09-declare.cjs"));
    expect(Object.keys(extras.compensations ?? {})).toEqual(["undo-write"]);
    expect(typeof extras.snapshot).toBe("function");
    expect(await extras.snapshot?.()).toEqual({ phase: "declared-writer" });
  });

  it("坏形状在装载期就拒：表不是对象 / 表为空 / 值不是函数 / snapshot 不是函数", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ compensations: 42 }, /compensations is not usable/],
      [{ compensations: [] }, /compensations is not usable/],
      [{ compensations: {} }, /an empty table/],
      [{ compensations: { u: "nope" } }, /compensations\["u"\]/],
      [{ snapshot: "yes" }, /snapshot is not usable/],
    ];
    for (const [extras, re] of cases) {
      expect(() => normalizeLegacyExtras(cjsLikeFn(extras))).toThrowError(CordisAdapterError);
      expect(() => normalizeLegacyExtras(cjsLikeFn(extras))).toThrowError(re);
    }
  });

  it("拒绝码是承接层本地的 ADAPTER/SHAPE-INVALID（映射期错误，不入 Core 词表、不落账本）", () => {
    try {
      normalizeLegacyExtras(cjsLikeFn({ compensations: { u: 1 } }));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as CordisAdapterError).code).toBe("ADAPTER/SHAPE-INVALID");
    }
  });
});
