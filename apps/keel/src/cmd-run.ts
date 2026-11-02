/**
 * keel run —— 装配 manifest 并启动一次 demo Run（A1/A2 载体；04 稿 §2）。
 * 薄壳：装配 + 内置 demo driver（调 manifest 声明的工具 N 轮后收束），业务全在 packages/。
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunDriver } from "@keel/core";
import {
  assembleManifest,
  buildRuntime,
  closeRuntime,
  readRun,
  runPolicy,
  wireRun,
} from "./runtime.js";

export interface RunOptions {
  /** manifest JSON 文件路径。 */
  manifest: string;
  /** 插件 .mjs 路径（Cell 进程加载面）。 */
  plugin: string;
  /** demo driver 调用的工具名（缺省 ok——tests/fixtures/ok-plugin.mjs 的工具）。 */
  tool?: string;
  /** 轮数（缺省 2：轮 1 调工具，轮 2 收束）。 */
  rounds?: number;
  dataDir?: string;
}

/** @returns 退出码：0 = 终态 halted；1 = 其他终态/异常。 */
export async function cmdRun(opts: RunOptions): Promise<number> {
  const manifest = assembleManifest(JSON.parse(readFileSync(opts.manifest, "utf-8")));
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(tmpdir(), "keel-run-")));
  const rt = await buildRuntime(dataDir, { policy: runPolicy(manifest, "keel-cli") });
  try {
    const tool = opts.tool ?? "ok";
    const total = opts.rounds ?? 2;
    const driver: RunDriver = {
      decide: async (c) =>
        c.round < total
          ? { summary: `call ${tool}`, actions: [{ kind: "tool", tool, params: {} }] }
          : { done: true, summary: "demo-end" },
    };
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const run = await wireRun(rt, { runId, driver, manifest, pluginPath: opts.plugin });
    const status = await run.done;
    const events = await readRun(rt, runId);
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    console.info(`runId:  ${runId}`);
    console.info(
      `status: ${status.state}${"reasonCode" in status && status.reasonCode ? ` (${status.reasonCode})` : ""}`,
    );
    console.info(
      `events: ${events.length} → ${[...counts].map(([t, n]) => `${t}×${n}`).join(" ")}`,
    );
    return status.state === "halted" ? 0 : 1;
  } finally {
    await closeRuntime(rt);
    if (!opts.dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}
