/**
 * keel hotswap —— 热装配升级复演（A5/V5；04 稿 §2）。
 * 先演示迁移钩失败 → 回退旧作用域（V5 主张），再演示成功原子切换（replacesVersion 留痕）。
 * 真实装配链：Assembler + Supervisor（ManagedCell = SupervisedCell）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssemblyManager, Assembler, type ManagedCell } from "@keel/host";
import type { Scope } from "@keel/core";
import { buildRuntime, closeRuntime, fixturePath, loadSchema } from "./runtime.js";

export interface HotswapOptions {
  dataDir?: string;
}

export interface HotswapOutcome {
  rollbackOk: boolean;
  switchOk: boolean;
  lines: string[];
}

const scope: Scope = { agentId: "keel-cli", sessionId: "hotswap-demo" };

/** 有状态演示 manifest：v1 无迁移；v2 带 migration（from ^1.0）；插件决定迁移成败。 */
function manifestRaw(version: string, migration: boolean): unknown {
  return {
    kind: "capability",
    meta: { name: "stateful-demo", version, title: "S", description: "hotswap demo" },
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
    ...(migration
      ? {
          migration: {
            from: "^1.0",
            steps: [{ to: version, action: { type: "hook", ref: "migrate" } }],
          },
        }
      : {}),
  };
}

/** 热装配复演主体（scenario a5 与本命令共用）。 */
export async function hotswapDemo(dataDir: string): Promise<HotswapOutcome> {
  const rt = await buildRuntime(dataDir);
  const lines: string[] = [];
  const assembler = new Assembler({ schema: loadSchema() });
  const manager = new AssemblyManager({
    assembler,
    factory: { spawn: (spec) => rt.supervisor.spawnCell(spec) },
  });
  const cells = new Set<ManagedCell>();
  try {
    const v1 = assembler.assemble(manifestRaw("1.0.0", false));
    const v1Binding = manager.bind(scope, {
      manifest: v1,
      pluginPath: fixturePath("recover-plugin.mjs"),
    });
    cells.add(v1Binding.cell);
    lines.push(`bind: stateful-demo@1.0.0 (${fixturePath("recover-plugin.mjs")})`);
    // AssemblyManager 自持绑定表：spawn 出的 Cell 不经 wireRun 的 bindings——
    // 收束由调用方负责（V5 语义：旧 Cell 在换绑后由调用方 dispose）

    // ── V5 回退主张：迁移钩失败 → 新 Cell 丢弃、旧绑定原样、账本无全局突变
    let rollbackOk = false;
    try {
      await manager.hotSwap(scope, {
        rawManifest: manifestRaw("1.1.0", true),
        pluginPath: fixturePath("migration-fail-plugin.mjs"),
      });
      lines.push("FAIL: migration-fail swap unexpectedly succeeded");
    } catch (err) {
      const code = (err as { code?: string }).code;
      const current = manager.current(scope)?.manifest.meta.version;
      rollbackOk = code === "SCHED/MANIFEST-INVALID" && current === "1.0.0";
      lines.push(`rollback: migration hook failed → ${code}; current=${current} (expect 1.0.0)`);
    }

    // ── 成功路径：迁移钩正常 → 原子换绑 + replacesVersion 留痕
    const { record } = await manager.hotSwap(scope, {
      rawManifest: manifestRaw("1.1.0", true),
      pluginPath: fixturePath("recover-plugin.mjs"),
    });
    const switchOk =
      record.manifest.version === "1.1.0" &&
      record.replacesVersion === "1.0.0" &&
      manager.current(scope)?.manifest.meta.version === "1.1.0";
    lines.push(
      `switch: stateful-demo@${String(record.manifest.version)} replaces=${String(record.replacesVersion)}; current=${String(manager.current(scope)?.manifest.meta.version)}`,
    );
    return { rollbackOk, switchOk, lines };
  } finally {
    const cur = manager.current(scope);
    if (cur) cells.add(cur.cell);
    await Promise.allSettled([...cells].map((c) => c.dispose()));
    await closeRuntime(rt);
  }
}

/** @returns 退出码：0 = 回退与切换均符合 V5 主张；1 = 有偏差。 */
export async function cmdHotswap(opts: HotswapOptions): Promise<number> {
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(tmpdir(), "keel-hotswap-")));
  try {
    const out = await hotswapDemo(dataDir);
    for (const line of out.lines) console.info(line);
    const ok = out.rollbackOk && out.switchOk;
    console.info(
      `hotswap: ${ok ? "PASS" : "FAIL"} (rollback=${out.rollbackOk} switch=${out.switchOk})`,
    );
    return ok ? 0 : 1;
  } finally {
    if (!opts.dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}
