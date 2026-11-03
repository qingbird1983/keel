/**
 * SnapshotStore 落盘面（切片⑤ §3.2，B7② 的存储侧细项）。
 *
 * 主张逐条：ref 形状不变但**不是路径**（竖线在 Windows 非法）；冷启动版本号接续（不覆盖历史）；
 * 写是原子的（不留 .tmp 残件）；内容不可序列化或写不进去 = 抛错，绝不返回 null 让调用方
 * 以为"这舱没状态"；同一目录的新实例读得回旧内容（"宿主重启后可恢复"的存储根据）。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "../src/snapshot.js";

let root: string;
let dir: string;
const scope = { agentId: "agent-1", sessionId: "sess-1" };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keel-snap-"));
  dir = path.join(root, "snapshots");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SnapshotStore（落盘）", () => {
  it("ref 形状一字未改，而路径里没有竖线（ref 是标识符不是路径）", async () => {
    const s = new SnapshotStore({ rootDir: dir });
    const meta = await s.save(scope, 1, { ticks: 1 });
    expect(meta).toEqual({ ref: "agent-1|sess-1/snap-1", version: 1 });
    const files = await readdir(path.join(dir, "agent-1", "sess-1"));
    expect(files).toEqual(["snap-1.json"]);
    expect(
      JSON.parse(await readFile(path.join(dir, "agent-1", "sess-1", "snap-1.json"), "utf8")),
    ).toEqual({ state: { ticks: 1 }, version: 1, round: 1 });
  });

  it("同目录的新实例（= 重启后的宿主进程）读得回旧内容，版本号接着往上走", async () => {
    const first = new SnapshotStore({ rootDir: dir });
    const m1 = await first.save(scope, 1, { ticks: 1 });
    const m2 = await first.save(scope, 2, { ticks: 2 });

    const restarted = new SnapshotStore({ rootDir: dir });
    expect(await restarted.get(m2!.ref)).toEqual({ state: { ticks: 2 }, version: 2, round: 2 });
    expect(await restarted.get(m1!.ref)).toMatchObject({ version: 1 });
    // 冷启动必须扫出已有最大版本：否则新内容会写进 snap-1，把历史快照毁掉
    const m3 = await restarted.save(scope, 3, { ticks: 3 });
    expect(m3).toMatchObject({ version: 3, ref: "agent-1|sess-1/snap-3" });
  });

  it("写是原子的：落定后目录里只剩正式文件，不留 .tmp 残件", async () => {
    const s = new SnapshotStore({ rootDir: dir });
    await s.save(scope, 1, { a: 1 });
    const files = await readdir(path.join(dir, "agent-1", "sess-1"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("内容不可 JSON 序列化 → 抛错（不返回 null，也不留半个文件）", async () => {
    const s = new SnapshotStore({ rootDir: dir });
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    await expect(s.save(scope, 1, circular)).rejects.toThrow();
    // 函数值同样不可序列化
    await expect(s.save(scope, 2, { fn: () => 1 })).rejects.toThrow();
    const entries = await readdir(path.join(dir, "agent-1", "sess-1")).catch(() => [] as string[]);
    expect(entries.filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("无状态舱（state = null/undefined）不写、返回 null——这是既有口径，不是静默降级", async () => {
    const s = new SnapshotStore({ rootDir: dir });
    expect(await s.save(scope, 1, null)).toBeNull();
    expect(await s.save(scope, 2, undefined)).toBeNull();
    await expect(readdir(dir)).rejects.toThrow(); // 连目录都不该建
  });

  it("非法 ref、缺条目、被外部删掉 → undefined（读方按「内容不在」处理）", async () => {
    const s = new SnapshotStore({ rootDir: dir });
    expect(await s.get("no-slash-at-all")).toBeUndefined();
    expect(await s.get("agent-1|sess-1/not-a-snap")).toBeUndefined();
    expect(await s.get("agent-1|sess-9/snap-1")).toBeUndefined();
    const meta = await s.save({ agentId: "agent-1", sessionId: "sess-9" }, 1, { v: 1 });
    expect(await s.get(meta!.ref)).toMatchObject({ state: { v: 1 } });
    // 外部破坏：文件半截 → 读方不崩，按"内容不在"
    await writeFile(path.join(dir, "agent-1", "sess-9", "snap-1.json"), "{trunc", "utf8");
    expect(await s.get(meta!.ref)).toBeUndefined();
  });

  it("scope 之间互不可见（分区口径与账本一致：不存在跨 scope 的同名版本号）", async () => {
    const s = new SnapshotStore({ rootDir: dir });
    const a = await s.save({ agentId: "agent-1", sessionId: "sess-A" }, 1, { who: "A" });
    const b = await s.save({ agentId: "agent-1", sessionId: "sess-B" }, 1, { who: "B" });
    expect(a!.ref).not.toBe(b!.ref);
    expect(await s.get(a!.ref)).toMatchObject({ state: { who: "A" } });
    expect(await s.get(b!.ref)).toMatchObject({ state: { who: "B" } });
    // B 的第二版不受 A 影响（版本号按 scope 各自单调）
    const b2 = await s.save({ agentId: "agent-1", sessionId: "sess-B" }, 2, { who: "B2" });
    expect(b2).toMatchObject({ version: 2 });
  });

  it("dropScope 只清本 scope（测试与人工排障用的收束面）", async () => {
    const s = new SnapshotStore({ rootDir: dir });
    await s.save(scope, 1, { a: 1 });
    await s.save({ agentId: "agent-1", sessionId: "sess-2" }, 1, { b: 1 });
    await s.dropScope(scope);
    expect(await readdir(path.join(dir, "agent-1"))).toEqual(["sess-2"]);
    // 清掉后重新计数是本 scope 的语义（不是跨 scope 泄漏）
    expect(await s.save(scope, 1, { a: 2 })).toMatchObject({ version: 1 });
  });
});
