/**
 * 策略插件的进程入口 —— 宿主 `spawnCell({manifest: <policy 报关单>, pluginPath, cellEntry: <本文件 dist>, bootstrapExtra: {hooks}})` 的目标。
 *
 * 与默认入口（`main.ts` = 一次 Run 的能力舱）的差别是**架构性的**，不是实现细节（ADR-0012）：
 * - 只登记 `export const hooks`，**不注入 `CellClient`**：契约 §3.3 给策略插件的那一行写的是
 *   "四个 hook 被调用（被动），无主动接口"——本入口连主动通道的句柄都不给；
 * - 受理的 op 只有 `policy.hook`（+ 装载门共用的 `cell.snapshot` 应答）；
 * - 时限不在这造第二套：策略报关单的 `resources` 必须是空对象，插话预算 = 宿主请求超时 +
 *   内核 HookBus 超时（两处都按契约 §7 的 200ms，且失败一律走既有 fallback 口径）；
 * - 装载期即校验"导出集合 == 声明集合"，两张皮就不起舱（就绪探测拿不到应答 = 宿主明确拒绝装配）。
 *
 * 崩溃语义与另两个入口同源（ADR-0005 前提）：未捕获异常 / 未决拒绝 = 非零退出。
 */

import { pathToFileURL } from "node:url";
import { startCell } from "./cell.js";
import { normalizePolicyHooks } from "./policy-hooks.js";

interface PolicyBootstrap {
  pluginPath: string;
  /** 报关单声明的插话点（宿主从 LoadedManifest.hooks 传入；本入口据此校验导出集合）。 */
  hooks: string[];
}

function crash(err: unknown): never {
  process.stderr.write(
    `[policy-cell-crash] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
}

process.on("uncaughtException", (err) => crash(err));
process.on("unhandledRejection", (reason) => crash(reason));

void (async () => {
  let boot: PolicyBootstrap;
  try {
    boot = JSON.parse(process.argv[2] ?? "") as PolicyBootstrap;
  } catch {
    crash(new Error("invalid policy bootstrap argv"));
  }
  if (!boot.pluginPath || !Array.isArray(boot.hooks) || boot.hooks.length === 0) {
    crash(new Error("incomplete policy bootstrap (need pluginPath + non-empty hooks)"));
  }
  const mod: unknown = await import(pathToFileURL(boot.pluginPath).href);
  // 校验先于建舱：形状不对就没有"起了一半的策略舱"这种中间态
  const table = normalizePolicyHooks(mod, boot.hooks);
  const cell = startCell({
    input: process.stdin,
    output: process.stdout,
    // 策略舱不受理 tool.exec：0 = 即便误发也不会长期占住舱（唯一的时限在宿主/内核那两处）
    toolCallTimeoutMs: 0,
    // 装载门（ADR-0011）：登记完成之前不应答——宿主的一次 cell.snapshot 探测即"装载完成"凭据
    loadGate: true,
  });
  cell.setHooks(table);
  cell.markReady();
})().catch((err) => crash(err));
