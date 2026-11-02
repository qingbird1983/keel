/**
 * keel observe —— 给"一张报关单都没有"的旧插件产候选报关单（03 稿 §7；B2 的抓手）。
 *
 * 落两份文件：`<name>.candidate.json`（候选，字节可 diff）与 `<name>.gaps.md`（缺项清单 = 人工审核的待办）。
 * 退出码 = 候选能否过五步校验（0 过 / 1 不过并打印缺项）。
 * **本命令不转正任何东西**（§10 第 2 条）：候选补齐 gaps、经审核后才作为正式报关单进装配。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { synthesizeName } from "@keel/host";
import { cellEntryPath, cordisCellEntryPath } from "./runtime.js";
import { observePlugin, type ObservePluginResult } from "./observe.js";

export interface ObserveOptions {
  /** 旧插件文件（.cjs/.mjs）。 */
  plugin: string;
  /** Cell 装载入口：缺省 legacy（承接层）；default = 内核默认入口（新生态形状）。 */
  entry?: string;
  /** 候选与缺项清单的落盘目录（缺省 = 插件同级的 `observed/`）。 */
  out?: string;
  /** 观察账本根目录（缺省 = 系统临时目录）。 */
  dataDir?: string;
  /** 单次工具调用超时（进候选 resources，待审项）。 */
  toolTimeoutMs?: number;
}

function gapsMarkdown(r: ObservePluginResult, name: string): string {
  const lines = [
    `# gaps: ${r.pluginFile}`,
    "",
    `候选名：\`${name}\`（合成版本 0.0.0，转正时由作者改写）`,
    `观察到的工具：${r.candidate.toolNames.map((n) => `\`${n}\``).join(", ") || "（无）"}`,
    `观察到的能力：${r.candidate.caps.join(", ") || "（无）"}`,
    "",
    "## 缺项清单（这些是合成给不出来的东西，必须人工补）",
    "",
  ];
  if (r.candidate.gaps.length === 0) lines.push("（无缺项——仍须经人工审核后转正）");
  for (const g of r.candidate.gaps) lines.push(`- **${g.code}** — ${g.detail}`);
  lines.push("", "## 观察证据", "");
  for (const p of r.passes) {
    lines.push(
      `- pass ${p.index} run \`${p.runId}\`：终态 ${p.status.state}，${p.events.length} 条事件，屏障放弃=${p.barrierGaveUp}`,
    );
  }
  return lines.join("\n") + "\n";
}

/** @returns 退出码：0 = 候选过五步校验；1 = 不过（或观察本身失败）。 */
export async function cmdObserve(opts: ObserveOptions): Promise<number> {
  const pluginPath = path.resolve(opts.plugin);
  const entry = opts.entry === "default" ? cellEntryPath : cordisCellEntryPath;
  const outDir = path.resolve(opts.out ?? path.join(path.dirname(pluginPath), "observed"));
  await mkdir(outDir, { recursive: true });
  const name = synthesizeName(path.basename(pluginPath));

  const r = await observePlugin({
    dataDir: opts.dataDir ?? path.join(outDir, `${name}-ledger`),
    pluginPath,
    cellEntry: entry,
    agentId: "keel-observe",
    sessionId: `sess-observe-${name}`,
    toolCallTimeoutMs: opts.toolTimeoutMs,
  });

  const candidateFile = path.join(outDir, `${name}.candidate.json`);
  const gapsFile = path.join(outDir, `${name}.gaps.md`);
  await writeFile(candidateFile, r.candidateJson + "\n", "utf-8");
  await writeFile(gapsFile, gapsMarkdown(r, name), "utf-8");

  console.info(`observe: ${path.basename(pluginPath)} → ${r.passes.length} 趟观察`);
  for (const p of r.passes) {
    console.info(
      `  pass ${p.index}: ${p.runId} state=${p.status.state} events=${p.events.length} names=[${p.candidate.toolNames.join(", ")}]`,
    );
  }
  console.info(`  candidate: ${candidateFile}`);
  console.info(`  gaps: ${gapsFile}（${r.candidate.gaps.length} 项，待人工审核）`);
  if (r.assembleError) {
    console.info(`  validate: REJECT — ${r.assembleError}`);
    return 1;
  }
  console.info(
    `  validate: ACCEPT（${String(r.assembled?.meta.name)}@${String(r.assembled?.meta.version)}，` +
      `cap=${r.assembled?.permissions.map((p) => p.cap).join(",")}）`,
  );
  console.info(
    "  note: 候选不自转正——补齐 gaps 并经人工审核后，才作为正式报关单进装配（03 稿 §10）",
  );
  return 0;
}
