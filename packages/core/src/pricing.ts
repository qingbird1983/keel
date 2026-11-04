/**
 * 按桶计价（Phase 4 切片③，02 稿 M3 / research/02 §6/§7）。
 *
 * 费用权威在 Core：`kind:"model"` 的模块只报用量（三桶），价格表来自 manifest，
 * 网关用宿主时钟判定峰谷档后按 `Σ(bucket × 单价) / 1e6` 计算（单位固定 usd_per_mtok）。
 * 单桶单价会算错约 50 倍（缓存命中）或 2 倍（峰谷），所以桶与档都是硬形状，不做"猜"。
 */

import { KeelError } from "./errors.js";

/** 计价三桶：命中缓存输入 / 未命中缓存输入 / 输出。 */
export interface PricingTier {
  inputCached: number;
  inputUncached: number;
  output: number;
}

/** 峰时窗口（UTC；法定节假日不建模，未知档按 `unknownTier` 保守处理）。 */
export interface PeakWindow {
  /** `mon` 或 `mon-fri`（装配器已限定形态）。 */
  days: string;
  /** `HH:MM-HH:MM`（UTC；允许跨零点，如 `22:00-02:00`）。 */
  utc: string;
}

/** manifest `model.pricing.<型号>`（02 稿 §4 / R11）。 */
export interface ModelPricing {
  unit: "usd_per_mtok";
  offPeak: PricingTier;
  peak?: PricingTier;
  peakWindows?: PeakWindow[];
  /** 峰谷判定落在窗口之外/不可判定时的保守档，缺省 `peak`（不静默按谷价）。 */
  unknownTier?: "peak" | "offPeak";
}

/** 一次调用的用量（模块上报的唯一计量输入）。 */
export interface UsageBuckets {
  inputCached: number;
  inputUncached: number;
  output: number;
}

export type PricingTierName = "peak" | "offPeak";

const BUCKETS = ["inputCached", "inputUncached", "output"] as const;
const DAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * 校验并归一模块上报的 `usage`：三桶必填、非负有限。缺失 = 显式失败，
 * 不按 0 计（"没报"与"用了 0"是两件事，静默按 0 会把账做小）。
 */
export function readUsageBuckets(usage: unknown): UsageBuckets {
  const u = (usage ?? {}) as Record<string, unknown>;
  const out: Partial<UsageBuckets> = {};
  for (const bucket of BUCKETS) {
    const v = u[bucket];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new KeelError("GATEWAY/UPSTREAM-ERROR", "model upstream usage is not bucketed", {
        reason: "UPSTREAM_USAGE_INVALID",
        bucket,
      });
    }
    out[bucket] = v;
  }
  return out as UsageBuckets;
}

/** 按宿主时钟（UTC）判定峰谷档；`peak` 缺失时只能按谷价计。 */
export function pricingTier(pricing: ModelPricing, at: Date): PricingTierName {
  if (!pricing.peak) return "offPeak";
  const matched = (pricing.peakWindows ?? []).some((w) => windowContains(w, at));
  if (!pricing.peakWindows || pricing.peakWindows.length === 0) {
    return pricing.unknownTier ?? "peak";
  }
  return matched ? "peak" : "offPeak";
}

/** 计价：返回实结金额与该次调用落在的档。 */
export function priceUsage(
  pricing: ModelPricing,
  buckets: UsageBuckets,
  at: Date,
): { cost: number; tier: PricingTierName } {
  const tier = pricingTier(pricing, at);
  const prices = tier === "peak" && pricing.peak ? pricing.peak : pricing.offPeak;
  const raw =
    (buckets.inputCached * prices.inputCached +
      buckets.inputUncached * prices.inputUncached +
      buckets.output * prices.output) /
    1_000_000;
  // 金额只保留 12 位小数：去掉浮点求和噪声（0.1+0.2+0.4 不应长成 0.7000000000000001）
  return { cost: Math.round(raw * 1e12) / 1e12, tier };
}

function windowContains(w: PeakWindow, at: Date): boolean {
  if (!dayMatches(w.days, at.getUTCDay())) return false;
  const [from, to] = w.utc.split("-");
  const start = minutesOf(from);
  const end = minutesOf(to);
  const now = at.getUTCHours() * 60 + at.getUTCMinutes();
  if (start === null || end === null) return false;
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

function minutesOf(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function dayMatches(days: string, day: number): boolean {
  return days.split(",").some((token) => {
    const [a, b] = token.trim().split("-");
    const from = DAY_INDEX[a];
    const to = DAY_INDEX[b];
    if (from === undefined) return false;
    if (b === undefined) return day === from;
    if (to === undefined) return false;
    return from <= to ? day >= from && day <= to : day >= from || day <= to;
  });
}
