import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, type EffectDeclaredPayload, type LedgerEvent, type RunRef } from "@keel/core";
import type { EffectReceipt } from "@keel/runtime-context";
import {
  CompensationExecutor,
  type ActionCellFactory,
  type CompensationActionCell,
  type ToolResultLike,
} from "../src/compensator.js";
import type { BuiltinAction } from "../src/builtins.js";
import type { CompensationExecInput } from "@keel/cell-runtime";

let dir: string;
const ledgers: Ledger[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-comp-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const scope = { agentId: "agent-1", sessionId: "sess-1" };
const ref: RunRef = { ...scope, runId: "run-1" };

/** 内存动作 Cell 替身：记录调用，可编程结果。 */
function fakeCell(handler?: (input: CompensationExecInput) => ToolResultLike | unknown): {
  cell: CompensationActionCell;
  calls: CompensationExecInput[];
  disposed: () => number;
} {
  const calls: CompensationExecInput[] = [];
  let disposed = 0;
  const cell: CompensationActionCell = {
    exec: async (input) => {
      calls.push(input);
      const r = handler?.(input);
      if (r && typeof r === "object" && "status" in (r as object)) return r as ToolResultLike;
      return { status: "ok", result: (r ?? null) as unknown, durationMs: 1 };
    },
    dispose: async () => void disposed++,
  };
  return { cell, calls, disposed: () => disposed };
}

function rig(
  cell?: ReturnType<typeof fakeCell>,
  opts?: {
    parallel?: number;
    onAlert?: (i: unknown) => Promise<void>;
    builtins?: ReadonlyMap<string, BuiltinAction>;
  },
) {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  const delays: number[] = [];
  let factoryCalls = 0;
  const factory: ActionCellFactory | null = cell
    ? async () => {
        factoryCalls += 1;
        return cell.cell;
      }
    : null;
  const executor = new CompensationExecutor(
    { ledger, factory },
    {
      delay: async (ms) => void delays.push(ms),
      now: () => 0,
      parallel: opts?.parallel,
      onAlert: opts?.onAlert,
      builtins: opts?.builtins,
    },
  );
  return { ledger, executor, delays, factoryCalls: () => factoryCalls };
}

async function declare(
  ledger: Ledger,
  over?: Partial<EffectDeclaredPayload>,
): Promise<LedgerEvent> {
  const payload: EffectDeclaredPayload = {
    effectId: over?.effectId ?? `e-${crypto.randomUUID().slice(0, 8)}`,
    kind: over?.kind ?? "webfetch.request-sent",
    targetSummary: over?.targetSummary ?? { url: "http://x" },
    compensationClass: over?.compensationClass ?? "reversible",
    compensation: over?.compensation ?? {
      actionRef: "compensations/cancel",
      paramsDigest: { amt: 1 },
      idempotency: "keyed",
    },
    probeRef: over?.probeRef ?? null,
    dependsOn: over?.dependsOn ?? [],
    retention: over?.retention ?? null,
  };
  return ledger.append(ref, "EFFECT_DECLARED", payload);
}

async function typesOf(ledger: Ledger): Promise<string[]> {
  return (await ledger.read({ runId: ref.runId })).events.map((e) => e.type);
}

describe("CompensationExecutor：投影重建（账本唯一事实源）", () => {
  it("declared → settled → executed 状态链重放", async () => {
    const { ledger, executor } = rig();
    const ev = await declare(ledger);
    const effectId = (ev.payload as { effectId: string }).effectId;
    await ledger.append(ref, "EFFECT_SETTLED", { effectId, outcome: "done" });
    await ledger.append(ref, "COMPENSATION_EXECUTED", {
      effectId,
      attempt: 2,
      resultDigest: null,
      durationMs: 3,
    });
    const p = await executor.project(ref);
    const e = p.get(effectId);
    expect(e).toMatchObject({ state: "compensated", attempts: 2, kind: "webfetch.request-sent" });
  });

  it("settled unknown → verify-pending；failed-clean → released 语义（不进候选）", async () => {
    const { ledger, executor } = rig(fakeCell());
    await declare(ledger, { effectId: "e-1" });
    await declare(ledger, { effectId: "e-2" });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-1", outcome: "unknown" });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-2", outcome: "failed-clean" });
    const p = await executor.project(ref);
    expect(p.get("e-1")?.state).toBe("verify-pending");
    expect(p.get("e-2")?.state).toBe("settled-failed");
  });
});

describe("CompensationExecutor：补偿编排（T01~T14）", () => {
  it("run 模式：settled-done 撤销，动作入参与 EXECUTED 落账，用后 dispose", async () => {
    const cell = fakeCell(() => ({ undone: true }));
    const { ledger, executor } = rig(cell);
    const ev = await declare(ledger, { effectId: "e-1" });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-1", outcome: "done" });
    const ok = await executor.compensate(ref, { mode: "run" });
    expect(ok).toBe(true);
    expect(cell.calls[0]).toMatchObject({
      actionRef: "compensations/cancel",
      effectId: "e-1",
      phase: "undo",
      paramsDigest: { amt: 1 },
    });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      attempt: 1,
      resultDigest: { undone: true },
    });
    expect(cell.disposed()).toBe(1);
    expect(evs.at(-1)?.seq).toBeGreaterThan(ev.seq);
  });

  it("verify 模式：只核验不回滚（T4），无补偿事件", async () => {
    const cell = fakeCell();
    const { ledger, executor } = rig(cell);
    await declare(ledger, { effectId: "e-1" });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-1", outcome: "done" });
    expect(await executor.compensate(ref, { mode: "verify" })).toBe(true);
    expect(cell.calls).toHaveLength(0);
    expect(await typesOf(ledger)).not.toContain("COMPENSATION_EXECUTED");
  });

  it("round 模式：fromSeq 划界（最近一致点后的才补偿，T1）", async () => {
    const cell = fakeCell();
    const { ledger, executor } = rig(cell);
    await declare(ledger, { effectId: "early" }); // seq 2（首事件 RUN? 无——seq 从 1 起）
    await declare(ledger, { effectId: "late" });
    const all = (await ledger.read({ runId: ref.runId })).events;
    const earlySeq =
      all.find((e) => (e.payload as { effectId?: string }).effectId === "early")?.seq ?? 0;
    const ok = await executor.compensate(ref, { mode: "round", fromSeq: earlySeq });
    expect(ok).toBe(true);
    expect(cell.calls.map((c) => c.effectId)).toEqual(["late"]);
  });

  it("补偿失败 ≤3 次退避重试后 ESCALATED{blockedResume}（T11/T12），返回 false", async () => {
    const cell = fakeCell(() => ({ status: "error", error: { code: "X/NOPE" } }));
    const { ledger, executor, delays } = rig(cell);
    await declare(ledger, { effectId: "e-1" });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-1", outcome: "done" });
    const ok = await executor.compensate(ref, { mode: "run" });
    expect(ok).toBe(false);
    expect(cell.calls).toHaveLength(3);
    expect(delays).toEqual([1_000, 2_000]); // 退避 ≤30s 钳制
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      attempts: 3,
      blockedResume: true,
      lastError: { code: "X/NOPE" },
    });
  });

  it("record-only 直闭：EXECUTED{recordOnly} + 告警缝，无需动作 Cell（A6-3）", async () => {
    const alerts: unknown[] = [];
    const { ledger, executor } = rig(undefined, {
      onAlert: async (i) => void alerts.push(i),
    });
    await declare(ledger, {
      effectId: "e-1",
      compensationClass: "record-only",
      compensation: { actionRef: "audit/mark", paramsDigest: null, idempotency: "natural" },
    });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-1", outcome: "done" });
    expect(await executor.compensate(ref, { mode: "run" })).toBe(true);
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      resultDigest: { recordOnly: true },
    });
    expect(alerts).toHaveLength(1);
  });

  it("declared 未闭环保守并入候选（T02 并入 + 硬规则兜底）；verify-pending 保守补偿（T06）", async () => {
    const cell = fakeCell();
    const { ledger, executor } = rig(cell);
    await declare(ledger, { effectId: "e-1" }); // 崩溃残留：无 EFFECT_SETTLED
    await declare(ledger, { effectId: "e-2" });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-2", outcome: "unknown" });
    expect(await executor.compensate(ref, { mode: "run" })).toBe(true);
    expect(cell.calls.map((c) => c.effectId).sort()).toEqual(["e-1", "e-2"]);
  });

  it("waived 跳过；同层 LIFO（seq 降序撤销）；dependsOn 逆拓扑（依赖者后撤）", async () => {
    const cell = fakeCell();
    const { ledger, executor } = rig(cell);
    await declare(ledger, { effectId: "w", compensationClass: "mitigable" });
    await ledger.append(ref, "COMPENSATION_WAIVED", {
      effectId: "w",
      waivedBy: "owner",
      reason: "accepted loss",
    });
    await declare(ledger, { effectId: "a" });
    await declare(ledger, { effectId: "b" });
    await declare(ledger, { effectId: "dep", dependsOn: ["b"] }); // 依赖 b：dep 先撤、b 后撤
    expect(await executor.compensate(ref, { mode: "run" })).toBe(true);
    // 波1 = [dep, a]（就绪无在册依赖者，LIFO seq 降序）；波2 = [b]（依赖者 dep 已撤）
    expect(cell.calls.map((c) => c.effectId)).toEqual(["dep", "a", "b"]);
  });

  it("escalated 未豁免：其余照常执行但整体 false（补偿稿 §5.2）", async () => {
    const cell = fakeCell();
    const { ledger, executor } = rig(cell);
    await declare(ledger, { effectId: "stuck" });
    await ledger.append(ref, "COMPENSATION_ESCALATED", {
      effectId: "stuck",
      attempts: 3,
      lastError: { code: "X" },
      blockedResume: true,
    });
    await declare(ledger, { effectId: "fresh" });
    expect(await executor.compensate(ref, { mode: "run" })).toBe(false);
    expect(cell.calls.map((c) => c.effectId)).toEqual(["fresh"]); // stuck 未重派
  });

  it("waive/repair 出路（T13/T14）：waive 非升级态拒绝；repair 后重派归零", async () => {
    const cell = fakeCell(() => ({ status: "error", error: { code: "X" } }));
    const ledger = new Ledger({ rootDir: dir, now: () => 0 });
    ledgers.push(ledger);
    const delays: number[] = [];
    const executor = new CompensationExecutor(
      { ledger, factory: async () => cell.cell },
      { delay: async (ms) => void delays.push(ms), now: () => 0 },
    );
    await declare(ledger, { effectId: "e-1" });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-1", outcome: "done" });
    // 未升级先 waive → 拒
    await expect(executor.waive(ref, "e-1", "owner", "nope")).rejects.toMatchObject({
      code: "RECOVER/COMPENSATION-FAILED",
    });
    // 升级
    await executor.compensate(ref, { mode: "run" });
    // 修复后重补偿：全新 3 次预算，仍失败 → 再升级
    await executor.repair(ref, "e-1");
    expect(await executor.compensate(ref, { mode: "run" })).toBe(false);
    expect(cell.calls).toHaveLength(6); // 3 + 3（repair 归零重派）
    // 豁免收口（T13）
    await executor.waive(ref, "e-1", "owner", "manually resolved");
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({ effectId: "e-1", waivedBy: "owner" });
    expect(await executor.compensate(ref, { mode: "run" })).toBe(true); // waived 跳过
  });

  it("并行度切片：parallel=1 时波内串行（结果仍全部闭环）", async () => {
    const cell = fakeCell();
    const { ledger, executor } = rig(cell, { parallel: 1 });
    await declare(ledger, { effectId: "e-1" });
    await declare(ledger, { effectId: "e-2" });
    expect(await executor.compensate(ref, { mode: "run" })).toBe(true);
    expect(cell.calls).toHaveLength(2);
  });

  it("timeout 分类：动作超时与 error 同径 → 重试耗尽升级（切片⑤ always-slow 桩对应路径）", async () => {
    const cell = fakeCell(() => ({
      status: "timeout",
      error: { code: "CELL/COMPENSATION-FAILED" },
    }));
    const { ledger, executor, delays } = rig(cell);
    await declare(ledger, { effectId: "e-1" });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-1", outcome: "done" });
    expect(await executor.compensate(ref, { mode: "run" })).toBe(false);
    expect(cell.calls).toHaveLength(3);
    expect(delays).toEqual([1_000, 2_000]);
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      attempts: 3,
      blockedResume: true,
      lastError: { code: "CELL/COMPENSATION-FAILED" },
    });
  });

  it("mitigable 模板：缓解类照常派发动作闭环（T 状态机三分类全覆盖）", async () => {
    const cell = fakeCell(() => ({ mitigated: true }));
    const { ledger, executor } = rig(cell);
    await declare(ledger, {
      effectId: "e-1",
      compensationClass: "mitigable",
      compensation: {
        actionRef: "mitigate",
        paramsDigest: null,
        idempotency: "natural",
      },
    });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "e-1", outcome: "done" });
    expect(await executor.compensate(ref, { mode: "run" })).toBe(true);
    expect(cell.calls[0]).toMatchObject({ actionRef: "mitigate", phase: "undo" });
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      resultDigest: { mitigated: true },
    });
  });
});

describe("CompensationExecutor：内置补偿（ADR-0016）", () => {
  async function allowFsWrite(ledger: Ledger, pattern: string): Promise<void> {
    await ledger.append(ref, "ASSEMBLY_RECORDED", {
      manifest: { name: "file-writer", version: "0.1.0", kind: "capability" },
      permissions: [{ cap: "fs.write", allow: [pattern] }],
      compensation: [{ kind: "fs.write.done", compensationClass: "reversible" }],
    });
  }

  function builtinEffect(effectId: string, target: string): Partial<EffectDeclaredPayload> {
    return {
      effectId,
      kind: "fs.write.done",
      targetSummary: { path: target },
      compensationClass: "reversible",
      compensation: {
        actionRef: "fs.remove",
        actionType: "builtin",
        paramsDigest: null,
        idempotency: "natural",
      },
    };
  }

  /** 测试用收据：从真实文件读取身份（与 Workspace 写入后签发的形状一致）。 */
  async function receiptFor(
    effectId: string,
    target: string,
    mode: "create" | "overwrite" = "create",
  ): Promise<EffectReceipt> {
    const portable = target.replace(/\\/g, "/");
    const st = await lstat(portable);
    const buf = await readFile(portable);
    return {
      opId: effectId,
      kind: "fs.write.done",
      mode,
      target: portable,
      workspaceRoot: dir.replace(/\\/g, "/"),
      existed: mode === "overwrite",
      created: mode === "create",
      overwritten: mode === "overwrite",
      identity: {
        dev: String(st.dev),
        ino: String(st.ino),
        size: st.size,
        mtimeMs: st.mtimeMs,
        sha256: createHash("sha256").update(buf).digest("hex"),
      },
      timestamp: 0,
    };
  }

  it("fs.remove 成功：宿主直删文件，不 spawn 补偿 Cell，EXECUTED 落账", async () => {
    const { ledger, executor, factoryCalls } = rig();
    const target = path.join(dir, "created.txt").replace(/\\/g, "/");
    await writeFile(target, "x");
    await allowFsWrite(ledger, `fs:${dir.replace(/\\/g, "/")}/**`);
    await declare(ledger, builtinEffect("e-1", target));
    await ledger.append(ref, "EFFECT_SETTLED", {
      effectId: "e-1",
      outcome: "done",
      receipt: await receiptFor("e-1", target),
    });

    expect(await executor.compensate(ref, { mode: "run" })).toBe(true);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(factoryCalls()).toBe(0); // 纯 builtin 不创建补偿进程
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      attempt: 1,
      resultDigest: { removed: target },
    });
  });

  it("fs.remove 路径不在装配 allow 内 → AUTH/DENIED，3 次后升级且文件保留", async () => {
    const { ledger, executor, delays, factoryCalls } = rig();
    const target = path.join(dir, "protected.txt").replace(/\\/g, "/");
    await writeFile(target, "keep");
    await allowFsWrite(ledger, "fs:/somewhere/else/**");
    await declare(ledger, builtinEffect("e-1", target));
    await ledger.append(ref, "EFFECT_SETTLED", {
      effectId: "e-1",
      outcome: "done",
      receipt: await receiptFor("e-1", target),
    });

    expect(await executor.compensate(ref, { mode: "run" })).toBe(false);
    expect(delays).toEqual([1_000, 2_000]);
    expect(factoryCalls()).toBe(0);
    await expect(access(target)).resolves.toBeUndefined();
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      attempts: 3,
      blockedResume: true,
      lastError: { code: "AUTH/DENIED" },
    });
  });

  it("无 ASSEMBLY_RECORDED 权限基线 → fail-closed 拒绝（不猜宿主权限）", async () => {
    const { ledger, executor } = rig();
    const target = path.join(dir, "orphan.txt").replace(/\\/g, "/");
    await writeFile(target, "keep");
    await declare(ledger, builtinEffect("e-1", target));
    await ledger.append(ref, "EFFECT_SETTLED", {
      effectId: "e-1",
      outcome: "done",
      receipt: await receiptFor("e-1", target),
    });

    expect(await executor.compensate(ref, { mode: "run" })).toBe(false);
    await expect(access(target)).resolves.toBeUndefined();
    const evs = (await ledger.read({ runId: ref.runId })).events;
    expect(evs.at(-1)?.payload).toMatchObject({
      effectId: "e-1",
      lastError: { code: "AUTH/DENIED" },
    });
  });

  it("无收据 → 不进入补偿；伪造相对路径收据 → 拒绝而非误删宿主文件", async () => {
    const { ledger, executor } = rig();
    await allowFsWrite(ledger, "fs:**");
    await declare(ledger, builtinEffect("no-receipt", `${dir}/no-receipt.txt`));
    await declare(ledger, builtinEffect("rel", "relative.txt"));
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "no-receipt", outcome: "done" });
    await ledger.append(ref, "EFFECT_SETTLED", {
      effectId: "rel",
      outcome: "done",
      receipt: {
        opId: "rel",
        kind: "fs.write.done",
        mode: "create",
        target: "relative.txt",
        workspaceRoot: null,
        existed: false,
        created: true,
        overwritten: false,
        timestamp: 0,
      },
    });

    expect(await executor.compensate(ref, { mode: "run" })).toBe(false);
    const escalated = (await ledger.read({ runId: ref.runId })).events
      .filter((e) => e.type === "COMPENSATION_ESCALATED")
      .map((e) => e.payload as { effectId: string; lastError: { code: string } });
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.effectId).toBe("rel");
    expect(escalated[0]?.lastError.code).toBe("COMPENSATION/UNKNOWN");
  });

  it("builtin + plugin 混合候选：只开一次补偿 Cell，builtin 不经过它", async () => {
    const cell = fakeCell(() => ({ undone: true }));
    const { ledger, executor, factoryCalls } = rig(cell);
    const target = path.join(dir, "mix.txt").replace(/\\/g, "/");
    await writeFile(target, "x");
    await allowFsWrite(ledger, `fs:${dir.replace(/\\/g, "/")}/**`);
    await declare(ledger, builtinEffect("b-1", target));
    await declare(ledger, { effectId: "p-1" });
    await ledger.append(ref, "EFFECT_SETTLED", {
      effectId: "b-1",
      outcome: "done",
      receipt: await receiptFor("b-1", target),
    });
    await ledger.append(ref, "EFFECT_SETTLED", { effectId: "p-1", outcome: "done" });

    expect(await executor.compensate(ref, { mode: "run" })).toBe(true);
    expect(factoryCalls()).toBe(1);
    expect(cell.calls.map((c) => c.effectId)).toEqual(["p-1"]); // builtin 不进补偿进程
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
