import { describe, expect, it } from "vitest";
import { priceUsage, pricingTier, readUsageBuckets, type ModelPricing } from "../src/pricing.js";

const pricing: ModelPricing = {
  unit: "usd_per_mtok",
  offPeak: { inputCached: 0.1, inputUncached: 0.2, output: 0.4 },
  peak: { inputCached: 0.2, inputUncached: 0.4, output: 0.8 },
  peakWindows: [{ days: "mon-fri", utc: "01:00-04:00" }],
};

const buckets = { inputCached: 1_000_000, inputUncached: 1_000_000, output: 1_000_000 };

describe("按桶计价（Phase 4 切片③ / 02 稿 M3）", () => {
  it("三桶缺一即拒（没报 ≠ 用了 0）", () => {
    expect(() => readUsageBuckets({ inputCached: 1, inputUncached: 1 })).toThrowError(
      /not bucketed/,
    );
    expect(() => readUsageBuckets({ inputCached: -1, inputUncached: 1, output: 1 })).toThrowError(
      /not bucketed/,
    );
    expect(() => readUsageBuckets(undefined)).toThrowError(/not bucketed/);
    expect(readUsageBuckets(buckets)).toEqual(buckets);
  });

  it("峰谷按 UTC 窗口与星期判定（窗口内 = 峰，窗口外 = 谷）", () => {
    // 2026-11-04 是周三
    expect(pricingTier(pricing, new Date("2026-11-04T02:00:00Z"))).toBe("peak");
    expect(pricingTier(pricing, new Date("2026-11-04T04:00:00Z"))).toBe("offPeak"); // 右开
    expect(pricingTier(pricing, new Date("2026-11-04T12:00:00Z"))).toBe("offPeak");
    expect(pricingTier(pricing, new Date("2026-11-07T02:00:00Z"))).toBe("offPeak"); // 周六
  });

  it("跨零点窗口与缺省保守档", () => {
    const overnight: ModelPricing = {
      ...pricing,
      peakWindows: [{ days: "wed-thu", utc: "22:00-02:00" }],
    };
    expect(pricingTier(overnight, new Date("2026-11-04T23:00:00Z"))).toBe("peak");
    expect(pricingTier(overnight, new Date("2026-11-05T01:00:00Z"))).toBe("peak");
    expect(pricingTier(overnight, new Date("2026-11-04T12:00:00Z"))).toBe("offPeak");

    const noWindows: ModelPricing = { ...pricing, peakWindows: [] };
    expect(pricingTier(noWindows, new Date("2026-11-04T12:00:00Z"))).toBe("peak"); // 缺省落峰
    expect(pricingTier({ ...noWindows, unknownTier: "offPeak" }, new Date())).toBe("offPeak");
    expect(pricingTier({ ...pricing, peak: undefined }, new Date())).toBe("offPeak");
  });

  it("费用 = Σ(桶 × 单价) / 1e6，浮点噪声被抹平", () => {
    const peak = priceUsage(pricing, buckets, new Date("2026-11-04T02:00:00Z"));
    expect(peak).toEqual({ cost: 1.4, tier: "peak" });
    const off = priceUsage(pricing, buckets, new Date("2026-11-04T12:00:00Z"));
    expect(off).toEqual({ cost: 0.7, tier: "offPeak" });
    // 单桶不同价 → 结果对桶顺序不敏感、对单价敏感
    const cachedOnly = priceUsage(
      { ...pricing, offPeak: { inputCached: 0.003, inputUncached: 0.15, output: 0.6 } },
      { inputCached: 1_000_000, inputUncached: 0, output: 0 },
      new Date("2026-11-04T12:00:00Z"),
    );
    expect(cachedOnly.cost).toBe(0.003);
  });
});
