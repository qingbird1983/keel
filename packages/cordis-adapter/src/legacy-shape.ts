/**
 * 旧模块形状归一化 —— 承接层做的**唯一**"翻译"，只认形状、不改代码（02 稿 §4）。
 *
 * 存量插件的激活形状（旧框架常见三种）：
 *   1. `module.exports = function activate(ctx) {...}`（CJS 函数导出，最常见）
 *   2. `module.exports = { activate(ctx) {...} }`
 *   3. `export default function (ctx) {...}`（ESM；CJS 经 ESM 装载时 default = module.exports）
 * 认不出即 `ADAPTER/ENTRY-UNKNOWN`——不猜、不"试着调用第一个函数"，因为猜错会静默改变插件行为。
 *
 * 装载本身走 Node 自己的装载器（`import(pathToFileURL(...))` 对 `.cjs` 走 CJS loader）：
 * 插件里的动态 `require`、`__dirname`、require 缓存都按旧习惯工作，
 * 而每 Cell 一进程 ⇒ 装载缓存天然是舱内私有的（探针 probe-require / probe-proto 的断言基础）。
 * 承接层**不做**任何源码改写：无 AST 变换、无垫片注入、无字符串求值（02 稿 §7 判据 3）。
 */

import { CordisAdapterError, type CordisCtx } from "./core.js";

export type CordisActivator = (ctx: CordisCtx) => unknown;

interface MaybeShape {
  default?: unknown;
  activate?: unknown;
}

/** 把装载到的模块对象收敛成一个激活函数。 */
export function normalizeLegacyModule(mod: unknown): CordisActivator {
  const unwrapped =
    mod && typeof mod === "object" && "default" in (mod as MaybeShape)
      ? ((mod as MaybeShape).default ?? mod)
      : mod;

  if (typeof unwrapped === "function") {
    return unwrapped as CordisActivator;
  }
  if (
    unwrapped &&
    typeof unwrapped === "object" &&
    typeof (unwrapped as MaybeShape).activate === "function"
  ) {
    const activate = (unwrapped as { activate: (ctx: CordisCtx) => unknown }).activate;
    return (ctx) => activate(ctx);
  }
  const shape = unwrapped === null ? "null" : typeof unwrapped;
  throw new CordisAdapterError(
    "ADAPTER/ENTRY-UNKNOWN",
    `legacy plugin entry not recognized (expected module.exports=fn(ctx), {activate(ctx)} or ESM default fn(ctx)); got ${shape} —— 承接层不猜形状，猜错就是静默改变插件行为`,
  );
}
