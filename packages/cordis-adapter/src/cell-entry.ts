/**
 * 承接层的 Cell 进程入口 —— 宿主用 `spawnCell({ manifest, pluginPath, cellEntry: <本文件 dist> })`
 * 换入口承载旧插件（02 稿 §4 seam，ADR-0010 决策 8）；**bootstrap 载荷形状不变**。
 *
 * 与 @keel/cell-runtime 的默认入口的唯一差异 = 舱内装载的是**旧形状插件**：
 * 默认入口要 `export const tools`（新生态声明式），本入口把旧插件的激活函数喂一份旧形状 ctx，
 * 于是 `ctx.tools.register(name, schema, handler)` 这类代码一行不改地跑在自己的舱里。
 *
 * 崩溃语义与内核默认入口同源（ADR-0005 前提）：未捕获异常 / 未决拒绝 = 非零退出。
 * 这条在本入口尤其重要：旧代码若不 await 注册调用而该调用被内核拒绝，
 * 拒绝就是未决 Promise → 进程崩 → `RUN_FAILED{CELL/CRASH}` 落账——**可见失败**，
 * 而不是"注册悄悄没生效"（02 稿 §6 的表格第三行）。
 */

import { pathToFileURL } from "node:url";
import { startCell } from "@keel/cell-runtime";
import { createCordisCellCtx } from "./cell-port.js";
import { normalizeLegacyModule } from "./legacy-shape.js";

interface Bootstrap {
  pluginPath: string;
  toolCallTimeoutMs: number;
}

function crash(err: unknown): never {
  // 诊断走 stderr；帧通道只占 stdout/stdin（与内核默认入口同一约定）
  process.stderr.write(
    `[cordis-cell-crash] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
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
  const cell = startCell({
    input: process.stdin,
    output: process.stdout,
    toolCallTimeoutMs: boot.toolCallTimeoutMs,
  });
  const mod: unknown = await import(pathToFileURL(boot.pluginPath).href);
  const activate = normalizeLegacyModule(mod);
  // activation 里旧代码可以 await 注册；返回值不被解读（插件不接管控制流，I1/V6）
  await activate(createCordisCellCtx(cell));
})().catch((err) => crash(err));
