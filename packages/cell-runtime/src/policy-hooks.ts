/**
 * 策略模块的导出形状归一化（切片④回填项 ①，ADR-0012 决策 1）——只认形状、不改语义。
 *
 * 策略插件唯一的合法导出 = `export const hooks = { <hookName>: async fn }`。
 * **导出的键集必须与报关单声明的 `hooks` 完全相等**，两个方向都要拒：
 * - 少了（声明了却提供不了）：报关单与实现是两张皮，宿主按声明来问会得到"没登记"；
 * - 多了（没声明就插话）：那正是 D 档 #14"变相接管"的形态，白名单的意义就在于此。
 *
 * 拒绝发生在**装载期**（进程起不来 = 就绪探测拿不到应答 = 宿主明确拒绝装配），
 * 不在运行期降级：绝不"先把有的接上，缺的以后再说"——那是把静默降级写进策略链。
 */

import type { PolicyHookHandler } from "./cell.js";

interface MaybeModule {
  default?: unknown;
  hooks?: unknown;
}

/** 装载期拒绝（只进 stderr 与非零退出，不过通道、不入账本、不加错误码）。 */
export class PolicyLoadRefused extends Error {
  constructor(message: string) {
    super(`POLICY-LOAD-REFUSED: ${message}`);
    this.name = "PolicyLoadRefused";
  }
}

/** ESM 命名导出优先；CJS 经 ESM 装载时 `hooks` 挂在 default（= module.exports）上，两边都认。 */
function exportedHooks(mod: unknown): Record<string, unknown> {
  const owners: unknown[] = [mod];
  const unwrapped =
    mod && typeof mod === "object" && "default" in (mod as MaybeModule)
      ? ((mod as MaybeModule).default ?? mod)
      : mod;
  owners.unshift(unwrapped);
  for (const o of owners) {
    if (o && (typeof o === "object" || typeof o === "function")) {
      const v = (o as MaybeModule).hooks;
      if (v !== undefined) return v as Record<string, unknown>;
    }
  }
  throw new PolicyLoadRefused(
    `no "hooks" export (expected export const hooks = { <hookName>: fn }); policy plugins get no other surface — 策略插件只插话，不持有主动接口（契约 §3.3）`,
  );
}

/**
 * 把策略模块的 `hooks` 收敛成登记表，并与报关单声明逐名核对。
 * @param mod 装载到的模块对象（`await import(...)` 的结果）
 * @param declared 报关单 `manifest.hooks`（schema 已保证 ⊆ 四 hook 白名单且非空）
 */
export function normalizePolicyHooks(
  mod: unknown,
  declared: readonly string[],
): Record<string, PolicyHookHandler> {
  const raw = exportedHooks(mod);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyLoadRefused(`hooks export must be a plain object, got ${typeof raw}`);
  }
  const names = Object.keys(raw);
  if (names.length === 0) {
    throw new PolicyLoadRefused("hooks export is an empty table (nothing to register)");
  }
  for (const [name, fn] of Object.entries(raw)) {
    if (typeof fn !== "function") {
      throw new PolicyLoadRefused(`hooks["${name}"] must be a function, got ${typeof fn}`);
    }
  }
  const want = [...declared].sort();
  const got = [...names].sort();
  const missing = want.filter((h) => !got.includes(h));
  const extra = got.filter((h) => !want.includes(h));
  if (missing.length > 0 || extra.length > 0) {
    throw new PolicyLoadRefused(
      `hooks export must equal the declared set ${JSON.stringify(want)}; ` +
        `missing=${JSON.stringify(missing)} undeclared=${JSON.stringify(extra)}` +
        `（少 = 报关单与实现两张皮；多 = 未申领的插话，正是 #14 要挡的那一支）`,
    );
  }
  return raw as unknown as Record<string, PolicyHookHandler>;
}
