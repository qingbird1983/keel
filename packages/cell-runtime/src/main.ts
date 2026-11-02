/**
 * Cell 进程入口 —— Supervisor spawn 的目标（ADR-0005：每 Cell 一个独立 OS 进程）。
 *
 * bootstrap 经 argv JSON 传入（插件路径/工具超时）；作用域由 Host 侧通道绑定盖章，
 * 本进程不可自报（防止越界伪装）；插件 = ESM 模块：
 * - `export const tools: CellTool[]`（tool.provide）
 * - `export function migrate(oldState)` 可选（manifest migration 钩，A5；恢复挂载共用通道，切片④）
 * - `export const compensations` 可选（补偿动作表，切片④：宿主补偿执行器经新 Cell 调用）
 * - `export function snapshot()` 可选（私有状态索取面，切片④：无导出 = 无状态 Cell）
 *
 * 崩溃语义（ADR-0005 crash 分类的前提）：未捕获异常/未决拒绝 = 进程非零退出——
 * 舱内崩溃必须可见于退出分类，禁止静默存活。
 */

import { pathToFileURL } from "node:url";
import { startCell, type CellTool, type CompensationHandler } from "./cell.js";

interface Bootstrap {
  pluginPath: string;
  toolCallTimeoutMs: number;
}

interface PluginModule {
  tools?: CellTool[];
  migrate?: (oldState: unknown) => Promise<unknown> | unknown;
  compensations?: Record<string, CompensationHandler>;
  snapshot?: () => Promise<unknown> | unknown;
}

function crash(err: unknown): never {
  // stderr 不入 stdio 帧（帧通道只在 stdout/stdin；诊断走 stderr）
  process.stderr.write(
    `[cell-crash] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
}

process.on("uncaughtException", (err) => crash(err));
process.on("unhandledRejection", (reason) => crash(reason));

void (async () => {
  let boot: Bootstrap;
  try {
    boot = JSON.parse(process.argv[2] ?? "") as Bootstrap;
  } catch {
    crash(new Error("invalid bootstrap argv"));
  }
  if (!boot.pluginPath || !boot.toolCallTimeoutMs) {
    crash(new Error("incomplete bootstrap"));
  }
  const mod = (await import(pathToFileURL(boot.pluginPath).href)) as PluginModule;
  const cell = startCell({
    input: process.stdin,
    output: process.stdout,
    toolCallTimeoutMs: boot.toolCallTimeoutMs,
  });
  for (const tool of mod.tools ?? []) cell.registerTool(tool);
  if (mod.migrate) cell.setMigration(mod.migrate);
  if (mod.compensations) cell.setCompensations(mod.compensations);
  if (mod.snapshot) cell.setSnapshotProvider(mod.snapshot);
})().catch((err) => crash(err));
