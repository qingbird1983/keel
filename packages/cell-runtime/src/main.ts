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
import {
  startCell,
  type CellTool,
  type CompensationHandler,
  type PluginSetupContext,
} from "./cell.js";
import type { CellGovernancePlan } from "./governance.js";

interface Bootstrap {
  pluginPath: string;
  toolCallTimeoutMs: number;
  /** 宿主编译的治理计划（ADR-0015）；缺省 = 无切面。 */
  governance?: CellGovernancePlan;
}

interface PluginModule {
  tools?: CellTool[];
  /** R4：资源清理与运行期工具登记（在静态工具发布前执行）。 */
  setup?: (ctx: PluginSetupContext) => Promise<unknown> | unknown;
  /** R4：模块级清理（先于资源 effect；可选）。 */
  dispose?: () => Promise<unknown> | unknown;
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
  // 0 是合法值（Phase 4 engine kind）：engine 只受理 engine.step，不受理 tool.exec——
  // 与策略舱的 0 同义；把 0 当"缺省"会让 resources 为空对象的 kind 一装载即 crash。
  if (!boot.pluginPath || typeof boot.toolCallTimeoutMs !== "number") {
    crash(new Error("incomplete bootstrap"));
  }
  const mod = (await import(pathToFileURL(boot.pluginPath).href)) as PluginModule;
  const cell = startCell({
    input: process.stdin,
    output: process.stdout,
    toolCallTimeoutMs: boot.toolCallTimeoutMs,
    // 装载门（ADR-0011）：静态工具登记完成之前不受理宿主请求——显式开闸而不是依赖
    // "startCell 本来就在 import 之后"的巧合，这样漏调 markReady 会表现为就绪超时（可见失败）。
    loadGate: true,
    governance: boot.governance,
  });
  // 装载义务（ADR-0011 注记 2026-11-03；03 稿 §4.1）= 本地执行表登记 **和** 宿主侧分区发布，
  // 两者完成才开闸。发布走既有 op tool.register（ADR-0010 通道，两步式与承接层 cell-port 同形）：
  // 宿主侧完成 AUTH 裁决 + scope 分区写 + 挂起 TOOL_SCHEMA_CHANGED（run 首轮入账）——
  // 没有发布，决策输入（c.tools / tool.discover）对静态工具全盲（03 稿 F4）。
  // R4：setup 先登记资源与动态工具，再发布静态工具；任一步失败 = crash（可见失败）。
  if (mod.setup) await mod.setup(cell.setupContext());
  for (const tool of mod.tools ?? []) cell.registerTool(tool);
  for (const tool of mod.tools ?? []) {
    try {
      await cell.client.registerTool(tool.name, tool.schema ?? null);
    } catch (err) {
      // 任一发布失败 = 进程 crash（可见失败优于静默降级）：本地表随进程消亡，无需承接层式回滚；
      // 宿主侧表现为就绪探测失败（通道断 / 超时）→ wireCell 拒绝装配。
      crash(
        new Error(
          `static tool registration failed: ${tool.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
  }
  if (mod.migrate) cell.setMigration(mod.migrate);
  if (mod.compensations) cell.setCompensations(mod.compensations);
  if (mod.snapshot) cell.setSnapshotProvider(mod.snapshot);
  if (mod.dispose) cell.setDisposeHook(mod.dispose);
  cell.markReady();
})().catch((err) => crash(err));
