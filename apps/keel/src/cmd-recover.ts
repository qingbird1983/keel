/**
 * keel recover —— 恢复演练：recover.plan + execute（A3；04 稿 §2）。
 * plan 打印一致点 / 未决清单 / 快照引用 → execute 先补偿再以新 runId 延续（ADR-0004 §4.4 顺序）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunDriver, RunRef } from "@keel/core";
import {
  assembleManifest,
  buildRuntime,
  closeRuntime,
  fixturePath,
  readRun,
  wireRun,
} from "./runtime.js";

export interface RecoverOptions {
  dataDir: string;
  run: string;
  /** 延续 Cell 的插件路径（缺省 tests/fixtures/recover-plugin.mjs）。 */
  plugin?: string;
  /** manifest JSON 路径（缺省内置 recover 演示 manifest）。 */
  manifest?: string;
  /** 延续 driver 首轮调用的工具（缺省 get-state）。 */
  tool?: string;
}

/** 从数据目录布局 `<agentId>/<sessionId>/<runId>/` 反查 RunRef（CLI 侧作用域补全）。 */
export function findRunRef(dataDir: string, runId: string): RunRef | null {
  for (const agentId of readdirSync(dataDir)) {
    const agentDir = path.join(dataDir, agentId);
    for (const sessionId of readdirSync(agentDir)) {
      if (readdirSync(path.join(agentDir, sessionId)).includes(runId)) {
        return { agentId, sessionId, runId };
      }
    }
  }
  return null;
}

const j = (v: unknown): string => JSON.stringify(v);

/** @returns 退出码：0 = 恢复延续成功；1 = plan/execute 失败或 run 不存在。 */
export async function cmdRecover(opts: RecoverOptions): Promise<number> {
  const oldRef = findRunRef(opts.dataDir, opts.run);
  if (!oldRef) {
    console.error(`recover: run "${opts.run}" not found in ${opts.dataDir}`);
    return 1;
  }
  const pluginPath = opts.plugin ?? fixturePath("recover-plugin.mjs");
  const manifest = opts.manifest
    ? assembleManifest(JSON.parse(readFileSync(opts.manifest, "utf-8")))
    : assembleManifest(recoverManifestRaw());
  const rt = await buildRuntime(opts.dataDir);
  try {
    const plan = await rt.recovery.plan(oldRef);
    console.info(`plan: oldRunId=${plan.oldRunId}`);
    console.info(
      `  checkpoint: ${plan.checkpoint ? `round=${plan.checkpoint.round} seq=${plan.checkpoint.seq}` : "none"}`,
    );
    console.info(
      `  pending: ${plan.pending.length} → ${plan.pending.map((e) => `${e.effectId}(${e.state})`).join(", ") || "none"}`,
    );
    console.info(
      `  snapshot: ${plan.snapshot ? `${j(plan.snapshot.ref)} v${String(plan.snapshot.version)} round=${String(plan.snapshot.round)}` : "none"}`,
    );

    const newRunId = `run-${randomUUID().slice(0, 8)}`;
    const tool = opts.tool ?? "get-state";
    let mounted: unknown;
    const driver: RunDriver = {
      decide: async (c) => {
        if (c.round === 1) {
          return { summary: "resume", actions: [{ kind: "tool", tool, params: {} }] };
        }
        mounted = c.history[0]?.resultDigest;
        return { done: true, summary: "recovered-end" };
      },
    };
    const resumed = await rt.recovery.execute(oldRef, async (_p, mountState) => {
      const run = await wireRun(rt, {
        runId: newRunId,
        scope: { agentId: oldRef.agentId, sessionId: oldRef.sessionId },
        driver,
        manifest,
        pluginPath,
        mountState,
        recoveredFrom: { runId: oldRef.runId, seq: plan.checkpoint?.seq ?? 0 },
      });
      return { runId: newRunId, done: run.done };
    });
    const status = await resumed.done;
    const evs = await readRun(rt, newRunId);
    const recovered = evs.find((e) => e.type === "RUN_RECOVERED");
    console.info(`execute: newRunId=${newRunId} status=${status.state}`);
    console.info(`  RUN_RECOVERED: ${recovered ? j(recovered.payload) : "MISSING"}`);
    console.info(`  mounted state: ${j(mounted)}`);
    return status.state === "failed" ? 1 : 0;
  } catch (err) {
    console.error(`recover failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await closeRuntime(rt);
  }
}

/** 兜底 manifest：与 tests/fixtures/recover-plugin.mjs 的模板契约一致（C-M1）。 */
function recoverManifestRaw(): unknown {
  return {
    kind: "capability",
    meta: { name: "stateful-demo", version: "1.0.0", title: "S", description: "keel recover demo" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 10_000 },
    compensation: {
      templates: [
        {
          kind: "recover.ticked",
          class: "record-only",
          action: { type: "plugin", ref: "mark" },
          idempotency: "natural",
        },
      ],
    },
    compat: { keelContract: "^1.0" },
  };
}
