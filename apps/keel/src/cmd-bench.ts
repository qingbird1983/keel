/**
 * keel bench —— A8 四项基准（04 稿 §3 口径）：只建测量不调优，无阈值断言。
 * B1 账本吞吐 / B2 网关延迟（壳层）/ B3 Cell 冷启 / B4 补偿编排延迟（观测项）
 * / B5 流式口径（切片⑤ §6：首片延迟、分片数、单 run 总延迟——同样只测量不设阈值）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunDriver, RunRef } from "@keel/core";
import { wireCell } from "@keel/host";
import {
  assembleManifest,
  buildRuntime,
  closeRuntime,
  fixturePath,
  runPolicy,
  wireRun,
} from "./runtime.js";

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

/** 流式基准用的报关单：`model.adapter` 编译出 model.invoke + model.stream 两条动作（ADR-0013 决策 6）。 */
function streamManifestRaw(): unknown {
  return {
    kind: "capability",
    meta: { name: "bench-stream", version: "1.0.0", title: "S", description: "bench streaming" },
    permissions: [{ cap: "tool.provide" }, { cap: "model.adapter" }],
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

    // ── B3 Cell 冷启动：起舱到可用（wireCell = spawn → serve → alloc → 就绪探测，ADR-0011）
    // → 首次工具往返（真实子进程），N=5。装载义务含静态工具发布（03 稿 §4），
    // 探测应答 = 发布完成的凭据——比旧口径（裸 spawnCell + 直发工具往返）多一次探测往返，
    // 但"可用"的定义从此不含未完成的装载。
    const manifest = assembleManifest(okManifestRaw());
    const rt3 = await buildRuntime(dir, {
      policy: runPolicy(manifest, "keel-cli"),
    });
    const cold: number[] = [];
    for (let i = 0; i < 5; i++) {
      const a = now();
      const scope = { agentId: "keel-cli", sessionId: `bench-cold-${String(i)}` };
      const { cell } = await wireCell({
        supervisor: rt3.supervisor,
        deps: {
          ledger: rt3.ledger,
          auth: rt3.auth,
          budget: rt3.budget,
          ctx: rt3.ctx,
          gateway: rt3.gateway,
        },
        scope,
        ref: { ...scope, runId: `bench-cold-${String(i)}` },
        subject: scope.agentId,
        manifest,
        pluginPath: fixturePath("ok-plugin.mjs"),
      });
      await cell.executor({ tool: "ok", params: {} });
      cold.push(ms(a, now()));
      await cell.drainAndReap();
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

    // ── B5a 流式（网关侧口径）：桩上游 20 片，默认页 16 → 两次取页；量首页到达与全流终局
    // 终局 = settle + MODEL_USAGE 落账之后，所以"全流"含记账成本（ADR-0003 的不变式在这里是成本项）
    const rt5 = await buildRuntime(dir);
    const stRef: RunRef = { ...scope, runId: "bench-stream" };
    const CHUNKS = 20;
    const firstPage: number[] = [];
    const fullStream: number[] = [];
    let streamProduced = 0;
    for (let i = 0; i < 8; i++) {
      const a = now();
      let page = await rt5.gateway.streamStart(stRef, "keel-bench", {
        reqId: `st-${i}`,
        model: "demo-model",
        params: { chunks: CHUNKS },
        estimate: 100,
      });
      firstPage.push(ms(a, now()));
      while (!page.done) {
        page = await rt5.gateway.streamNext(stRef, "keel-bench", page.streamId, 16);
      }
      fullStream.push(ms(a, now()));
      streamProduced = page.produced;
    }
    await closeRuntime(rt5);

    // ── B5b 流式（真舱通道口径）：一个 run 里舱内取完同一条流（三 op 跨 stdio 往返）
    // 与 B5a 的差 = 通道与舱进程的成本，正是"拉式分片要付的账"（ADR-0013 后果段）
    const streamManifest = assembleManifest(streamManifestRaw());
    // 授权主体 = wireRun 用的 scope.agentId（报关单编译必须以同一个 subject，否则流式当场被拒）
    const rt6 = await buildRuntime(dir, { policy: runPolicy(streamManifest, scope.agentId) });
    const cellStream: number[] = [];
    let cellChunks = 0;
    for (let i = 0; i < 3; i++) {
      const driver: RunDriver = {
        decide: async (c) =>
          c.round === 1
            ? {
                summary: "stream-all",
                actions: [
                  {
                    kind: "tool",
                    tool: "stream-all",
                    params: { reqId: `bench-cell-${i}`, chunks: CHUNKS, pageSize: 4 },
                  },
                ],
              }
            : { done: true, summary: "end" },
      };
      const a = now();
      const run = await wireRun(rt6, {
        runId: `bench-cell-stream-${i}`,
        scope: { agentId: "keel-bench", sessionId: `bench-cell-stream-${i}` },
        driver,
        manifest: streamManifest,
        pluginPath: fixturePath("stream-plugin.mjs"),
      });
      const st = await run.done;
      cellStream.push(ms(a, now()));
      if (st.state !== "halted") throw new Error(`bench B5b run did not halt: ${st.state}`);
      const events = await rt6.ledger.read({ runId: `bench-cell-stream-${i}` });
      const result = events.events
        .filter((e) => e.type === "TOOL_RESULT")
        .map((e) => e.payload as { resultDigest?: { produced?: number } })
        .at(-1);
      cellChunks = result?.resultDigest?.produced ?? cellChunks;
    }
    await closeRuntime(rt6);

    // 阈值不测（合同 §2「不做」第 6 条），但"量到的东西是不是那条流"必须核对：
    // 片数不对说明这一行量的根本不是流式（策略没放行、页取错、通道断了都会静默成 0 片）
    if (streamProduced !== CHUNKS || cellChunks !== CHUNKS) {
      throw new Error(
        `bench B5 did not pull the whole stream: gateway=${String(streamProduced)} cell=${String(cellChunks)} expected=${CHUNKS}`,
      );
    }
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
    console.info(
      `| B5a 流式（网关侧） | 桩上游 ${CHUNKS} 片，默认页 16 → 2 页取完；N=8（实测产出 ${streamProduced} 片） | 首页 min/p50 = ${Math.min(...firstPage).toFixed(2)}/${pct(firstPage, 0.5).toFixed(2)} ms；全流（含 settle+落账）min/p50 = ${Math.min(...fullStream).toFixed(2)}/${pct(fullStream, 0.5).toFixed(2)} ms |`,
    );
    console.info(
      `| B5b 流式（真舱通道） | 一个 run 内舱取完 ${CHUNKS} 片：1 次 start + 逐页 next（默认页 16 + pageSize 4 → 共 3 页 / 3 次往返）×3 | ${cellStream.map((v) => v.toFixed(0)).join(" / ")} ms/run（含起舱与两轮调度；实测舱内收到 ${cellChunks} 片） |`,
    );
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
