/**
 * B7⑤（07 稿 §3.1 + ADR-0008）：`DECISION.throughSeq` 落地，且 **Phase 1 的旧账本仍可读**。
 *
 * 事实假设（先写下再断言）：
 * - 账本不是单一写入者：`AUTH_DENIED` 由授权器直写（`authorizer.ts` 的留痕路径），
 *   不进调度器的 `h.events`，因此**不会**出现在任何决策的 `basedOn` 列举里——
 *   ADR-0008 背景段说的就是这个缺口（A6 实测的 seq 17）。
 * - `throughSeq` 是"本决策写入前该 run 已存在的最大 seq"，由**账本在写队列执行期盖章**：
 *   上界承载那笔直写事件，`basedOn` 继续只做关键引用（决策 1/2 的分工）。
 * - 本文件的 run 是内核真实 run（调度器 + 授权器 + 预算器 + 网关 + 账本），执行器是桩：
 *   "谁写了这笔事件"才是被检验的主张，进程边界由 `tests/audit-attribution-replay.test.ts` 承载。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  Authorizer,
  Budgeter,
  ContextManager,
  HookBus,
  Ledger,
  ModelGateway,
  Scheduler,
  type AuthPolicyInput,
  type DecisionPayload,
  type LedgerEvent,
  type RunDriver,
} from "@keel/core";

const repoRoot = process.cwd();
const cliBin = path.join(repoRoot, "apps", "keel", "dist", "main.js");

/** 只放 t1：驱动去调 ghost → 授权器当场拒绝并直写 AUTH_DENIED。 */
const POLICY: AuthPolicyInput = {
  version: "p-b75",
  allow: [{ subject: "cell-1", action: "tool.invoke", resource: "t1" }],
};

const scope = { agentId: "agent-1", sessionId: "sess-1" };
const ref = { ...scope, runId: "run-1" };

/** 跑一次真实内核 run（两轮：轮 1 的被拒动作、轮 2 收束），返回关盘后的事件序列。 */
async function realRun(dir: string): Promise<LedgerEvent[]> {
  const ledger = new Ledger({ rootDir: dir, now: () => 1_700_000_000_000 });
  const auth = new Authorizer(POLICY, ledger);
  const budget = new Budgeter(ledger);
  const ctx = new ContextManager();
  const hooks = new HookBus(ledger);
  const gateway = new ModelGateway({
    ledger,
    auth,
    budget,
    upstream: { invoke: async () => ({ result: "m", usage: {}, cost: 1 }) },
  });
  const scheduler = new Scheduler({ ledger, auth, budget, ctx, hooks, gateway });
  ctx.alloc(scope);
  ctx.registerTool(scope, { name: "t1", schemaVersion: 1, schema: {} });
  const driver: RunDriver = {
    decide: async (c) =>
      c.round === 1
        ? { summary: "call ghost", actions: [{ kind: "tool", tool: "ghost", params: {} }] }
        : { done: true, summary: "end" },
  };
  const { done } = scheduler.start({
    ref,
    subject: "cell-1",
    executor: async () => ({ status: "ok", result: "done" }),
    driver,
  });
  await done;
  await ledger.close(); // 确定性释放（P-005）：读方是另一个实例
  return await new Ledger({ rootDir: dir }).read({ runId: "run-1" }).then((p) => p.events);
}

const decisions = (evs: LedgerEvent[]): LedgerEvent[] => evs.filter((e) => e.type === "DECISION");

describe("B7⑤：DECISION.throughSeq 承载直写事件，旧账本仍可读", () => {
  it("被授权器直写的 AUTH_DENIED 不在 basedOn 里，但落在同一 run 后续决策的上界之内", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keel-b75-"));
    try {
      const evs = await realRun(dir);
      const denied = evs.find((e) => e.type === "AUTH_DENIED");
      expect(denied, "这条 run 必须真有一次授权拒绝").toBeDefined();
      const later = decisions(evs).filter((d) => d.seq > denied!.seq);
      expect(later.length).toBeGreaterThanOrEqual(1);
      for (const d of later) {
        const p = d.payload as DecisionPayload;
        // 关键引用不假装承载它（决策 1）……
        expect(p.basedOn).not.toContain(denied!.seq);
        // ……但上界承载它（决策 2）：归因表述因此是"依据 = basedOn，看得见的一切 ≤ throughSeq"
        expect(p.throughSeq).toBeDefined();
        expect(p.throughSeq!).toBeGreaterThanOrEqual(denied!.seq);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("每条 DECISION：basedOn 全在上界之内，且上界 = seq-1（单写者稠密性的哨兵）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keel-b75-"));
    try {
      const evs = await realRun(dir);
      expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1)); // seq 自 1 连续
      for (const d of decisions(evs)) {
        const p = d.payload as DecisionPayload;
        expect(p.throughSeq).toBe(d.seq - 1);
        expect(p.basedOn.every((s) => s >= 1 && s <= p.throughSeq!)).toBe(true);
      }
      // 信封版本按类型：DECISION = 2，其余 = 1（切片⑤ §7 第 1 项选定形状）
      expect(decisions(evs).every((d) => d.schemaVersion === 2)).toBe(true);
      expect(evs.filter((e) => e.type !== "DECISION").every((e) => e.schemaVersion === 1)).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("Phase 1 的旧账本样例：DECISION 没有 throughSeq，冷实例读不报错", async () => {
    const root = path.join(repoRoot, "fixtures", "ledger", "replay-decision-sequence");
    const page = await new Ledger({ rootDir: root }).read({ runId: "run-a" });
    const ds = decisions(page.events);
    expect(ds.length).toBeGreaterThan(0);
    for (const d of ds) {
      expect("throughSeq" in (d.payload as object)).toBe(false);
      // 旧样例的信封版本仍是 1（样例是记录下来的证据，本片不回写它）
      expect(d.schemaVersion).toBe(1);
    }
  });

  it("keel replay：新账本打出 throughSeq=数字，旧样例明说「没有显式上界」", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keel-b75-"));
    try {
      await realRun(dir);
      const fresh = execFileSync(
        process.execPath,
        [cliBin, "replay", "--data-dir", dir, "--run", "run-1"],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 60_000,
        },
      );
      expect(fresh).toMatch(/DECISION.*throughSeq=\d+/);

      const old = execFileSync(
        process.execPath,
        [
          cliBin,
          "replay",
          "--data-dir",
          path.join(repoRoot, "fixtures", "ledger", "replay-decision-sequence"),
          "--run",
          "run-a",
        ],
        { cwd: repoRoot, encoding: "utf-8", timeout: 60_000 },
      );
      // 读方不得因缺字段报错，也不能把它显示成"上界未知"就完事——要说是旧账本
      expect(old).toContain("no explicit bound: pre-v2 ledger");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
