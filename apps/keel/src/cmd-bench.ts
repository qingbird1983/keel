/**
 * keel bench —— A8 四项基准（04 稿 §3 口径）：只建测量不调优，无阈值断言。
 * B1 账本吞吐 / B2 网关延迟（壳层）/ B3 Cell 冷启 / B4 补偿编排延迟（观测项）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunRef } from "@keel/core";
import { assembleManifest, buildRuntime, closeRuntime, fixturePath } from "./runtime.js";

export interface BenchOptions {
  rounds?: number;
}

const ms = (t0: bigint, t1: bigint): number => Number(t1 - t0) / 1e6;
const now = (): bigint => process.hrtime.bigint();
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};

const scope = { agentId: "keel-bench", sessionId: "bench-1" };
const ref: RunRef = { ...scope, runId: "bench-run" };

function okManifestRaw(): unknown {
  return {
    kind: "capability",
    meta: { name: "bench-ok", version: "1.0.0", title: "B", description: "bench demo" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 10_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
  };
}

/** @returns 退出码（0 = 采集完成）。 */
export async function cmdBench(_opts: BenchOptions = {}): Promise<number> {
  const dir = await mkdtemp(path.join(tmpdir(), "keel-bench-"));
  try {
    // ── B1 账本吞吐：单 run 连续 append 2000 事件（warmup 100）+ 20 次 checkpoint 端到端
    const rt = await buildRuntime(dir);
    const N = 2000;
    for (let i = 0; i < 100; i++) await rt.ledger.append(ref, "DECISION", { warmup: true });
    const t0 = now();
    for (let i = 0; i < N; i++) await rt.ledger.append(ref, "DECISION", { round: 1, i });
    const appendMs = ms(t0, now());
    const cp0 = now();
    for (let i = 0; i < 20; i++) await rt.ledger.checkpoint(ref, i + 1);
    const cpMs = ms(cp0, now());
    await closeRuntime(rt);

    // ── B2 网关延迟：mock 即时 upstream 全链（授权→预扣→上游→实结→落账），N=50
    // （独立 runId：冷 Ledger 实例不允许向已存在账本的 run 接笔）
    const rt2 = await buildRuntime(dir);
    const gwRef: RunRef = { ...scope, runId: "bench-gateway" };
    rt2.budget.configure(scope, { run: 1e9, session: 1e9 });
    for (let i = 0; i < 10; i++) {
      await rt2.gateway.invoke(gwRef, "keel-bench", {
        reqId: `warm-${i}`,
        model: "demo-model",
        params: {},
        estimate: 1,
      });
    }
    const lat: number[] = [];
    for (let i = 0; i < 50; i++) {
      const a = now();
      await rt2.gateway.invoke(gwRef, "keel-bench", {
        reqId: `req-${i}`,
        model: "demo-model",
        params: {},
        estimate: 1,
      });
      lat.push(ms(a, now()));
    }
    await closeRuntime(rt2);

    // ── B3 Cell 冷启动：spawnCell → 首次工具往返（真实子进程），N=5
    const rt3 = await buildRuntime(dir);
    const manifest = assembleManifest(okManifestRaw());
    const cold: number[] = [];
    for (let i = 0; i < 5; i++) {
      const a = now();
      const run = await rt3.supervisor.spawnCell({
        manifest,
        pluginPath: fixturePath("ok-plugin.mjs"),
      });
      await run.executor({ tool: "ok", params: {} });
      cold.push(ms(a, now()));
      await run.drainAndReap();
    }
    await closeRuntime(rt3);

    // ── B4 补偿编排延迟（观测项）：8 效果 record-only 直闭，N=3
    const rt4 = await buildRuntime(dir);
    const orchestration: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r: RunRef = { ...scope, runId: `comp-${i}` };
      for (let k = 0; k < 8; k++) {
        await rt4.ledger.append(r, "EFFECT_DECLARED", {
          effectId: `e-${k}`,
          kind: "bench.effect",
          targetSummary: null,
          compensationClass: "record-only",
          compensation: { actionRef: "mark", paramsDigest: null, idempotency: "natural" },
          probeRef: null,
          dependsOn: [],
          retention: null,
        });
        await rt4.ledger.append(r, "EFFECT_SETTLED", { effectId: `e-${k}`, outcome: "done" });
      }
      const a = now();
      await rt4.compensator.compensate(r, { mode: "run" });
      orchestration.push(ms(a, now()));
    }
    await closeRuntime(rt4);

    // ── 汇总（markdown 片段，供 report.md 抄录）
    const node = process.version;
    const plat = `${process.platform}/${process.arch}`;
    console.info(
      `## A8 基准数据（${new Date().toISOString().slice(0, 10)}，${plat}，node ${node}）`,
    );
    console.info();
    console.info("| 指标 | 口径 | 结果 |");
    console.info("| --- | --- | --- |");
    console.info(
      `| B1 账本吞吐 | 单 run append ${N} 事件（warmup 100） | ${(N / (appendMs / 1000)).toFixed(0)} events/s（${appendMs.toFixed(1)} ms 总耗时） |`,
    );
    console.info(
      `| B1b 一致点 | ledger.checkpoint（fsync 语义）×20 | ${(cpMs / 20).toFixed(2)} ms/次 |`,
    );
    console.info(
      `| B2 网关延迟 | mock upstream 全链 N=50 | min/p50/p95 = ${Math.min(...lat).toFixed(1)}/${pct(lat, 0.5).toFixed(1)}/${pct(lat, 0.95).toFixed(1)} ms |`,
    );
    console.info(
      `| B3 Cell 冷启 | spawn→首工具往返 N=5 | min/p50 = ${Math.min(...cold).toFixed(0)}/${pct(cold, 0.5).toFixed(0)} ms |`,
    );
    console.info(
      `| B4 补偿编排（观测） | 8 效果 record-only 直闭 ×3 | ${orchestration.map((v) => v.toFixed(1)).join(" / ")} ms |`,
    );
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
