import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, type RunRef } from "@keel/core";
import { EffectTracker } from "../src/effects.js";
import { SnapshotStore } from "../src/snapshot.js";

let dir: string;
const ledgers: Ledger[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-fx-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const scope = { agentId: "agent-1", sessionId: "sess-1" };
const ref: RunRef = { ...scope, runId: "run-1" };

describe("EffectTracker：EFFECT_SETTLED 宿主结算（契约 §4.1 注记⑥）", () => {
  it("ok → done；error/timeout → unknown（保守）+ 原始错误摘要", async () => {
    const ledger = new Ledger({ rootDir: dir, now: () => 0 });
    ledgers.push(ledger);
    const t = new EffectTracker({ ledger });
    t.declared(ref, "e-1", []);
    await t.settleFor(ref, "ok");
    t.declared(ref, "e-2", []);
    await t.settleFor(ref, "error", { code: "X/BOOM" });
    const evs = (await ledger.read({ runId: ref.runId })).events.filter(
      (e) => e.type === "EFFECT_SETTLED",
    );
    expect(evs).toHaveLength(2);
    expect(evs[0].payload).toEqual({ effectId: "e-1", outcome: "done" });
    expect(evs[1].payload).toEqual({
      effectId: "e-2",
      outcome: "unknown",
      error: { code: "X/BOOM" },
    });
    expect(t.openCount("run-1")).toBe(0);
  });

  it("无未结效果 → 无事件（空窗口重复结算幂等）", async () => {
    const ledger = new Ledger({ rootDir: dir, now: () => 0 });
    ledgers.push(ledger);
    const t = new EffectTracker({ ledger });
    t.declared(ref, "e-1", []);
    await t.settleFor(ref, "ok");
    await t.settleFor(ref, "ok"); // 第二次 = 空窗口，不再写事件
    const evs = (await ledger.read({ runId: ref.runId })).events.filter(
      (e) => e.type === "EFFECT_SETTLED",
    );
    expect(evs).toHaveLength(1);
  });

  it("run 隔离：run-1 未结不影响 run-2 空结算", async () => {
    const ledger = new Ledger({ rootDir: dir, now: () => 0 });
    ledgers.push(ledger);
    const t = new EffectTracker({ ledger });
    t.declared(ref, "e-1", []);
    await t.settleFor({ ...ref, runId: "run-2" }, "ok");
    expect(t.openCount("run-1")).toBe(1);
    expect(t.openCount("run-2")).toBe(0);
  });
});

describe("EffectTracker：dependsOn 声明期校验（成环/未知引用即拒）", () => {
  it("未知引用拒绝；成环拒绝；合法链通过", async () => {
    const ledger = new Ledger({ rootDir: dir, now: () => 0 });
    ledgers.push(ledger);
    const t = new EffectTracker({ ledger });
    t.declared(ref, "a", []);
    t.declared(ref, "b", ["a"]);
    expect(() => t.validateDependency(ref, "c", ["ghost"])).toThrowError(
      expect.objectContaining({ code: "SCHED/MANIFEST-INVALID" }),
    );
    expect(() => t.validateDependency(ref, "b", ["b"])).toThrowError(
      expect.objectContaining({ code: "SCHED/MANIFEST-INVALID" }),
    );
    // a←b←c 合法链；跨 run 引用不可见即拒
    expect(() => t.validateDependency(ref, "c", ["b"])).not.toThrow();
    expect(() => t.validateDependency({ ...ref, runId: "run-2" }, "x", ["a"])).toThrowError(
      expect.objectContaining({ code: "SCHED/MANIFEST-INVALID" }),
    );
  });
});

describe("SnapshotStore（D3 内存持有）", () => {
  it("版本单调、ref 可取回；null 状态不写", () => {
    const s = new SnapshotStore();
    expect(s.save(scope, 1, { a: 1 })).toEqual({
      ref: "agent-1|sess-1/snap-1",
      version: 1,
    });
    expect(s.save(scope, 2, { a: 2 })).toMatchObject({ version: 2 });
    expect(s.get("agent-1|sess-1/snap-2")).toEqual({ state: { a: 2 }, version: 2, round: 2 });
    expect(s.get("agent-1|sess-1/snap-99")).toBeUndefined();
    expect(s.save(scope, 3, null)).toBeNull(); // 无状态 Cell 不写
  });
});
