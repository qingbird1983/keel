import { describe, expect, it } from "vitest";
import { EffectScope, RunContext, scopeKey } from "../src/index.js";

describe("EffectScope（资源 effect，ADR-0017）", () => {
  it("LIFO：后注册先清理；同步/异步都等待", async () => {
    const order: string[] = [];
    const scope = new EffectScope();
    scope.effect(() => {
      order.push("first");
    });
    scope.effect(async () => {
      await Promise.resolve();
      order.push("second");
    });
    scope.effect(() => {
      order.push("third");
    });
    await scope.dispose();
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("dispose 幂等：重复调用只清理一次，返回同一个 promise", async () => {
    let n = 0;
    const scope = new EffectScope();
    scope.effect(() => {
      n += 1;
    });
    const a = scope.dispose();
    const b = scope.dispose();
    expect(a).toBe(b);
    await a;
    expect(n).toBe(1);
  });

  it("单个 disposer 失败不阻断其余；结束后汇总 AggregateError", async () => {
    const order: string[] = [];
    const scope = new EffectScope();
    scope.effect(() => {
      order.push("ok-1");
    });
    scope.effect(() => {
      throw new Error("boom");
    });
    scope.effect(() => {
      order.push("ok-2");
    });
    await expect(scope.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(["ok-2", "ok-1"]);
  });

  it("提前移除：返回的函数只移除对应 disposer", async () => {
    const order: string[] = [];
    const scope = new EffectScope();
    const remove = scope.effect(() => {
      order.push("removed");
    });
    scope.effect(() => {
      order.push("kept");
    });
    remove();
    await scope.dispose();
    expect(order).toEqual(["kept"]);
  });

  it("dispose 后注册 = 明确失败（不静默丢弃）", async () => {
    const scope = new EffectScope();
    await scope.dispose();
    expect(() => scope.effect(() => undefined)).toThrowError(/disposed/);
  });
});

describe("RunContext（Run 级冻结）", () => {
  it("身份与能力袋冻结；外部修改不影响内部", () => {
    const ref = { agentId: "a", sessionId: "s", runId: "r1" };
    const caps: { workspace?: unknown } = { workspace: { root: "/w" } };
    const ctx = new RunContext(ref, caps);
    ref.runId = "changed";
    caps.workspace = { root: "/changed" };
    expect(ctx.ref.runId).toBe("r1");
    expect((ctx.capabilities.workspace as { root: string }).root).toBe("/w");
    expect(scopeKey(ctx.ref)).toBe("a|s");
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});
