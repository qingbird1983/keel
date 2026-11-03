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

import type { CompensationHandler } from "@keel/cell-runtime";
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

/** 旧插件装载时额外要交给宿主的两张面（04 稿 §2 F5）。 */
export interface CordisExtras {
  /** actionRef → 补偿动作执行体（宿主补偿执行器经一次性新 Cell 调 `compensation.exec`）。 */
  compensations?: Record<string, CompensationHandler>;
  /** 私有状态索取面（轮边界快照；本片只登记、不持久化）。 */
  snapshot?: () => Promise<unknown> | unknown;
}

/**
 * 旧形状能表达的"补偿表 + 快照面"——`module.exports.compensations = { "<actionRef>": fn }`
 * 与 `module.exports.snapshot = () => state`（ESM 的 `export const` 同读）。
 *
 * **形状换、语义不换**：承接层不代插件造补偿动作，也不把 `effects.reclaim()` 翻译成补偿
 * （那是换了名字的静默降级，04 稿 §10 第 4 条）。两张面缺省即不登记——
 * "登记空表"会让 `compensation.exec` 从 `CELL/ACTION-UNKNOWN`（明确未登记）变成另一种失败形态。
 *
 * 校验在**装载期**做，不留到出事那一轮：表里混进非函数值 = 回滚执行到一半才炸，
 * 而回滚半途失败正是补偿状态机最贵的场景（契约 §6）。
 */
export function normalizeLegacyExtras(mod: unknown): CordisExtras {
  const unwrapped =
    mod && typeof mod === "object" && "default" in (mod as MaybeShape)
      ? ((mod as MaybeShape).default ?? mod)
      : mod;
  const owners = [unwrapped, mod];
  const pick = (key: string): unknown => {
    for (const o of owners) {
      // 函数也算持有者：`module.exports = function activate(ctx){}` 之后挂属性是 CJS 常见写法
      if (o && (typeof o === "object" || typeof o === "function")) {
        const v = (o as Record<string, unknown>)[key];
        if (v !== undefined) return v;
      }
    }
    return undefined;
  };
  const invalid = (what: string, got: string): never => {
    throw new CordisAdapterError(
      "ADAPTER/SHAPE-INVALID",
      `legacy plugin ${what} is not usable: got ${got} —— 装载期即拒绝，不留到回滚执行到一半才炸（04 稿 §2 F5）`,
    );
  };

  const extras: CordisExtras = {};

  const table = pick("compensations");
  if (table !== undefined) {
    if (!table || typeof table !== "object" || Array.isArray(table)) {
      invalid("module.exports.compensations", typeof table);
    }
    const map: Record<string, CompensationHandler> = {};
    for (const [ref, fn] of Object.entries(table as Record<string, unknown>)) {
      if (typeof fn !== "function") invalid(`compensations["${ref}"]`, typeof fn);
      map[ref] = fn as CompensationHandler;
    }
    if (Object.keys(map).length === 0) {
      invalid("module.exports.compensations", "an empty table");
    }
    extras.compensations = map;
  }

  const snap = pick("snapshot");
  if (snap !== undefined && typeof snap !== "function") {
    invalid("module.exports.snapshot", typeof snap);
  }
  if (typeof snap === "function") extras.snapshot = snap as () => Promise<unknown> | unknown;

  return extras;
}
