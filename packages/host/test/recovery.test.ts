import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, type EffectDeclaredPayload, type RunRef } from "@keel/core";
import { CompensationExecutor } from "../src/compensator.js";
import { RecoveryManager } from "../src/recovery.js";
import { SnapshotStore } from "../src/snapshot.js";

let dir: string;
const ledgers: Ledger[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-rec-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const scope = { agentId: "agent-1", sessionId: "sess-1" };
const ref: RunRef = { ...scope, runId: "run-1" };

function rig() {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  const snapshots = new SnapshotStore();
  const compensator = new CompensationExecutor({ ledger, factory: null });
  const recovery = new RecoveryManager({ ledger, compensator, snapshots });
  return { ledger, snapshots, compensator, recovery };
}

async function declare(ledger: Ledger, effectId: string): Promise<void> {
  const payload: EffectDeclaredPayload = {
    effectId,
    kind: "k",
    targetSummary: null,
    compensationClass: "reversible",
    compensation: { actionRef: "a", paramsDigest: null, idempotency: "natural" },
    probeRef: null,
    dependsOn: [],
    retention: null,
  };
  await ledger.append(ref, "EFFECT_DECLARED", payload);
}

describe("RecoveryManager：plan（A3 恢复计划）", () => {
  it("未知 runId → RECOVER/RUN-UNKNOWN（契约 §4.5）", async () => {
    const { recovery } = rig();
    await expect(recovery.plan({ ...ref, runId: "ghost" })).rejects.toMatchObject({
      code: "RECOVER/RUN-UNKNOWN",
    });
  });

  it("一致点 + 未决清单 + 最近快照引用", async () => {
    const { ledger, snapshots, recovery } = rig();
    await ledger.append(ref, "RUN_STARTED", {});
    const cp = await ledger.checkpoint(ref, 1); // 一致点 seq 2
    await declare(ledger, "e-open"); // 一致点后声明、未结算 → 未决
    const snap = snapshots.save(scope, 1, { counter: 7 });
    await ledger.append(ref, "STATE_SNAPSHOT_REF", {
      ref: snap?.ref,
      version: snap?.version,
      round: 1,
    });
    const plan = await recovery.plan(ref);
    expect(plan.checkpoint).toMatchObject({ seq: cp.seq, round: 1 });
    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0]).toMatchObject({ effectId: "e-open", state: "declared" });
    expect(plan.snapshot).toMatchObject({ ref: snap?.ref, version: 1, round: 1 });
  });
});

describe("RecoveryManager：execute（ADR-0004 §4.4 顺序硬约束）", () => {
  it("先补偿（run 模式）后延续：未决效果闭环、快照挂载入 cont、recoveredFrom 由 cont 承接", async () => {
    const { ledger, snapshots, recovery } = rig();
    // 旧 run：声明效果即崩溃（未结算、未补偿）；record-only 免动作通道（闭环 = 审计持久）
    await ledger.append(ref, "RUN_STARTED", {});
    await ledger.checkpoint(ref, 1);
    await ledger.append(ref, "EFFECT_DECLARED", {
      effectId: "e-1",
      kind: "k",
      targetSummary: null,
      compensationClass: "record-only",
      compensation: { actionRef: "a", paramsDigest: null, idempotency: "natural" },
      probeRef: null,
      dependsOn: [],
      retention: null,
    });
    const snap = snapshots.save(scope, 1, { counter: 7 });
    await ledger.append(ref, "STATE_SNAPSHOT_REF", {
      ref: snap?.ref,
      version: snap?.version,
      round: 1,
    });
    await ledger.append(ref, "RUN_FAILED", { reasonCode: "CELL/CRASH" });

    const order: string[] = [];
    const result = await recovery.execute(ref, async (plan, mountState) => {
      order.push("cont");
      expect(plan.oldRunId).toBe("run-1");
      expect(mountState).toEqual({ counter: 7 });
      return { runId: "run-2", done: Promise.resolve({ state: "halted" }) };
    });
    expect(result.runId).toBe("run-2");
    expect(order).toEqual(["cont"]);
    // 补偿发生在 cont 之前：EXECUTED 已在账本（seq 早于 cont 无法直接比较，但能到 cont
    // = ① 补偿步已完整执行；此处断言闭环事实本身）
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      resultDigest: { recordOnly: true },
    });
  });

  it("无 factory 的可补偿效果 → execute 在 cont 前抛错（先核对后续跑，不跳过）", async () => {
    const { ledger, recovery } = rig();
    await ledger.append(ref, "RUN_STARTED", {});
    await declare(ledger, "e-1");
    await expect(
      recovery.execute(ref, async () => {
        throw new Error("must not reach continuation");
      }),
    ).rejects.toMatchObject({ code: "RECOVER/COMPENSATION-FAILED" });
  });

  it("账本有快照 ref 而存储缺条目 → RECOVER/SNAPSHOT-MISSING", async () => {
    const { ledger, snapshots } = rig();
    await ledger.append(ref, "RUN_STARTED", {});
    await ledger.checkpoint(ref, 1);
    const snap = snapshots.save(scope, 1, { x: 1 });
    await ledger.append(ref, "STATE_SNAPSHOT_REF", {
      ref: snap?.ref,
      version: snap?.version,
      round: 1,
    });
    await ledger.append(ref, "RUN_FAILED", { reasonCode: "CELL/CRASH" });
    // 模拟宿主重启丢失：新 store 无条目
    const fresh = new RecoveryManager({
      ledger,
      compensator: new CompensationExecutor({ ledger, factory: null }),
      snapshots: new SnapshotStore(),
    });
    void snapshots;
    await expect(
      fresh.execute(ref, async () => ({
        runId: "run-2",
        done: Promise.resolve({ state: "halted" }),
      })),
    ).rejects.toMatchObject({ code: "RECOVER/SNAPSHOT-MISSING" });
  });

  it("升级未豁免 → RECOVER/COMPENSATION-FAILED（T12 恢复阻断）", async () => {
    const { ledger, recovery } = rig();
    await ledger.append(ref, "RUN_STARTED", {});
    await declare(ledger, "e-1");
    await ledger.append(ref, "COMPENSATION_ESCALATED", {
      effectId: "e-1",
      attempts: 3,
      lastError: { code: "X" },
      blockedResume: true,
    });
    await expect(
      recovery.execute(ref, async () => ({
        runId: "run-2",
        done: Promise.resolve({ state: "halted" }),
      })),
    ).rejects.toMatchObject({ code: "RECOVER/COMPENSATION-FAILED" });
  });
});
