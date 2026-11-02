import { mkdtemp, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";

let dir: string;
let tick = 0;
const ledgers: Ledger[] = [];

/** 一切写入实例必须经本构造器（登记后 afterEach 统一 close；丢弃未关 = 把句柄释放交给 GC，见 P-005）。 */
function newLedger(root: string = dir, opts: { segMaxBytes?: number } = {}): Ledger {
  const l = new Ledger({
    rootDir: root,
    now: () => 1_700_000_000_000 + tick++,
    ...(opts.segMaxBytes !== undefined ? { segMaxBytes: opts.segMaxBytes } : {}),
  });
  ledgers.push(l);
  return l;
}

const ref = { agentId: "agent-1", sessionId: "sess-1", runId: "run-1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-ledger-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

describe("Ledger", () => {
  it("append → read 往返：信封字段完整，seq 按 Run 内单调", async () => {
    const ledger = newLedger();
    await ledger.append(ref, "DECISION", { round: 1, summary: "a", basedOn: [] });
    await ledger.append(ref, "TOOL_INVOKE", { round: 1, tool: "t", paramsDigest: null });

    const page = await ledger.read({ runId: "run-1" });
    expect(page.events).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(page.events[0]).toMatchObject({
      seq: 1,
      type: "DECISION",
      agentId: "agent-1",
      schemaVersion: 1,
    });
    expect(page.events[1]?.seq).toBe(2);
  });

  it("checkpoint 写入 CHECKPOINT 事件；lastCheckpoint 内存态与冷扫描一致", async () => {
    const ledger = newLedger();
    await ledger.append(ref, "DECISION", { round: 1 });
    const info = await ledger.checkpoint(ref, 1);
    expect(info).toEqual({ seq: 2, round: 1 });

    expect(await ledger.lastCheckpoint(ref)).toEqual({ seq: 2, round: 1 });

    // 冷实例（新 Ledger 对象）扫描文件得出同一一致点（A3 锚）
    const cold = newLedger();
    expect(await cold.lastCheckpoint(ref)).toEqual({ seq: 2, round: 1 });
  });

  it("read 过滤：类型 / seq 区间 / 游标分页", async () => {
    const ledger = newLedger();
    for (let i = 1; i <= 5; i++) {
      await ledger.append(ref, i % 2 === 0 ? "TOOL_INVOKE" : "DECISION", { i });
    }
    const byType = await ledger.read({ runId: "run-1", types: ["TOOL_INVOKE"] });
    expect(byType.events.map((e) => e.seq)).toEqual([2, 4]);

    const byRange = await ledger.read({ runId: "run-1", seqFrom: 2, seqTo: 4 });
    expect(byRange.events).toHaveLength(3);

    const page1 = await ledger.read({ runId: "run-1" }, undefined, 2);
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await ledger.read({ runId: "run-1" }, page1.nextCursor!, 2);
    expect(page2.events).toHaveLength(2);
    const page3 = await ledger.read({ runId: "run-1" }, page2.nextCursor!, 2);
    expect(page3.events).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    await expect(ledger.read({ runId: "run-1" }, "!!!not-a-cursor")).rejects.toMatchObject({
      code: "LEDGER/CURSOR-INVALID",
    });
  });

  it("崩溃安全：尾部撕裂行不阻断读取，一致点前数据完整可读（standards/05 §2.4）", async () => {
    const ledger = newLedger();
    await ledger.append(ref, "DECISION", { round: 1 });
    await ledger.checkpoint(ref, 1);
    await ledger.append(ref, "DECISION", { round: 2 });

    // 模拟写入中途被杀：半行 JSON 追加到段文件
    const segFile = path.join(dir, "agent-1", "sess-1", "run-1", "seg-000001.jsonl");
    await appendFile(segFile, '{"seq":4,"type":"DECISION","payl');

    const cold = newLedger();
    const page = await cold.read({ runId: "run-1" });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3]); // 撕裂行被丢弃，完整前缀可读
    expect(await cold.lastCheckpoint(ref)).toEqual({ seq: 2, round: 1 }); // 一致点不受影响
  });

  it("信任边界：非法 ID（路径穿越）拒绝写入", async () => {
    const ledger = newLedger();
    await expect(ledger.append({ ...ref, runId: "../evil" }, "DECISION", {})).rejects.toMatchObject(
      {
        code: "LEDGER/WRITE-FAILED",
      },
    );
    // 未知 run 的读取按寻址失败处理（契约 ledger.read 错误表）
    await expect(ledger.read({ runId: "run-1" })).rejects.toMatchObject({
      code: "LEDGER/CURSOR-INVALID",
    });
  });

  it("fail-stop：底层写失败后，该 run 后续一切写被拒绝", async () => {
    // 根目录是文件 → mkdir 失败 → 首写失败并锁存
    const { writeFile } = await import("node:fs/promises");
    const filePath = path.join(dir, "not-a-dir");
    await writeFile(filePath, "x");
    const ledger = newLedger(filePath);
    await expect(ledger.append(ref, "DECISION", {})).rejects.toMatchObject({
      code: "LEDGER/WRITE-FAILED",
    });
    await expect(ledger.append(ref, "DECISION", {})).rejects.toMatchObject({
      code: "LEDGER/WRITE-FAILED",
    });
    await expect(ledger.checkpoint(ref, 1)).rejects.toMatchObject({ code: "LEDGER/WRITE-FAILED" });
  });

  it("追加序保护：冷实例不允许向已存在账本的 run 接笔", async () => {
    const ledger = newLedger();
    await ledger.append(ref, "DECISION", {});
    const cold = newLedger();
    await expect(cold.append(ref, "DECISION", {})).rejects.toMatchObject({
      code: "LEDGER/WRITE-FAILED",
    });
  });

  it("段滚动：超过 segMaxBytes 后在一致点边界开新段", async () => {
    const ledger = newLedger(dir, { segMaxBytes: 1 }); // 阈值 1B → 每 checkpoint 必滚
    await ledger.append(ref, "DECISION", {});
    await ledger.checkpoint(ref, 1);
    await ledger.append(ref, "DECISION", {});
    await ledger.checkpoint(ref, 2);

    const page = await ledger.read({ runId: "run-1" });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]); // 跨段读取透明
    expect(await ledger.lastCheckpoint(ref)).toEqual({ seq: 4, round: 2 });
  });

  // 句柄释放的回归测试独立成文件（packages/core/test/ledger-fd-release.test.ts）：
  // 那里需要 mock node:fs/promises 才能拿到每个 FileHandle 的 close 记录点，不牵动本文件的其余用例。

  it("fixture 回放组：录制的旧样例跨实例可读且语义不变（standards/05 §2.3）", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("../../../fixtures/ledger/replay-basic", import.meta.url),
    );
    const cold = new Ledger({ rootDir: fixtureRoot, now: () => 0 });
    ledgers.push(cold);
    const page = await cold.read({ runId: "run-9" });
    expect(page.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "RUN_STARTED"],
      [2, "DECISION"],
      [3, "CHECKPOINT"],
      [4, "TOOL_INVOKE"],
    ]);
    expect(
      await cold.lastCheckpoint({ agentId: "agent-9", sessionId: "sess-9", runId: "run-9" }),
    ).toEqual({
      seq: 3,
      round: 1,
    });
  });

  it("fixture 回放组：决策序列样例全事件可读，归因关键事件齐备（A6 样例）", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("../../../fixtures/ledger/replay-decision-sequence", import.meta.url),
    );
    const cold = new Ledger({ rootDir: fixtureRoot, now: () => 0 });
    ledgers.push(cold);
    const page = await cold.read({ runId: "run-a" });
    expect(page.events.map((e) => e.seq)).toEqual([...Array(22)].map((_, i) => i + 1));
    const types = page.events.map((e) => e.type);
    for (const t of ["AUTH_DENIED", "HOOK_CALLED", "HOOK_VERDICT", "COMPENSATION_EXECUTED"]) {
      expect(types).toContain(t);
    }
    const denied = page.events.find((e) => e.type === "AUTH_DENIED");
    expect(denied?.payload).toMatchObject({ subject: "plugin:demo-audit", action: "tool.invoke" });
    expect(
      await cold.lastCheckpoint({ agentId: "agent-a", sessionId: "sess-a", runId: "run-a" }),
    ).toEqual({ seq: 17, round: 1 });
  });

  it("fixture 回放组：跨段样例 seq 连续、读取透明", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("../../../fixtures/ledger/replay-multi-seg", import.meta.url),
    );
    const cold = new Ledger({ rootDir: fixtureRoot, now: () => 0 });
    ledgers.push(cold);
    const page = await cold.read({ runId: "run-b" });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(page.events.at(-1)?.type).toBe("RUN_HALTED");
    expect(
      await cold.lastCheckpoint({ agentId: "agent-b", sessionId: "sess-b", runId: "run-b" }),
    ).toEqual({ seq: 4, round: 1 });
  });

  it("fixture 回放组：撕裂尾样例止于最后完整行（崩溃安全格式主张）", async () => {
    const fixtureRoot = fileURLToPath(
      new URL("../../../fixtures/ledger/replay-torn-tail", import.meta.url),
    );
    const cold = new Ledger({ rootDir: fixtureRoot, now: () => 0 });
    ledgers.push(cold);
    const page = await cold.read({ runId: "run-c" });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page.events.at(-1)?.type).toBe("CHECKPOINT");
    expect(
      await cold.lastCheckpoint({ agentId: "agent-c", sessionId: "sess-c", runId: "run-c" }),
    ).toEqual({ seq: 3, round: 1 });
  });
});
