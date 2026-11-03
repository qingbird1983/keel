// [ARCHIVED 2026-11-03 per ADR-0014 实施注记 3] Cordis 兼容层测试已剥离主线门禁（vitest.config.ts exclude）。
// 文件与断言保留在仓库，可单独复跑（npx vitest run <本文件>）； Phase 3 原生插件测试接管等强度覆盖前，此处不再被 CI 保护。
/**
 * 改法地面单测（切片③，04 稿 §3.1 / §5）——三个 C 档新面 → 通道 op 的映射形状。
 *
 * 现场与 `cell-port.test.ts` 同源：真 `startCell` + 内存帧通道 + 一个扮演内核的 serve 端。
 * 三条断言纪律：
 * 1. **参数不齐就一个帧都不发**——发到内核再被拒是"归因晚了"，插件会以为裁决来自内核；
 * 2. **内核错误码原样浮出**（`AUTH/DENIED`、`SCHED/MANIFEST-INVALID`、`BUDGET/EXHAUSTED`），
 *    承接层不改写归因（02 稿 §3 姿态 2）；
 * 3. **不替插件决定内核拥有的量**：effectId 由 Cell 侧指派、补偿动作由报关单决定，
 *    插件传了就是错（拒绝，而不是忽略——忽略等于假装拦截成功）。
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ContextManager } from "@keel/core";
import { ChannelError, FrameConn, startCell, type CellHandle } from "@keel/cell-runtime";
import type { CordisCtx } from "../src/index.js";
import { createCordisCellCtx } from "../src/cell-port.js";
import { createCordisCtx } from "../src/host-port.js";

interface Kernel {
  ops: { op: string; params: Record<string, unknown> }[];
  cell: CellHandle;
  cordis: CordisCtx;
  /** 下一次 model.invoke 的拒绝码（模拟内核裁决，承接层不参与）。 */
  denyModel: string | null;
  /** 只有报关单里有的 effectKind。 */
  declaredKinds: string[];
  /** 内核在自己那侧看到的 run（盖章值，Cell 传什么都不认）。 */
  stampedRunId: string;
}

function kernelRig(): Kernel {
  const k: Kernel = {
    ops: [],
    cell: null as unknown as CellHandle,
    cordis: null as unknown as CordisCtx,
    denyModel: null,
    declaredKinds: ["fs.write.done"],
    stampedRunId: "run-kernel",
  };
  const hostToCell = new PassThrough();
  const cellToHost = new PassThrough();
  const cell = startCell({ input: hostToCell, output: cellToHost, toolCallTimeoutMs: 200 });
  const core = new FrameConn({ input: cellToHost, output: hostToCell });
  core.serve(async (op, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    k.ops.push({ op, params: p });
    switch (op) {
      case "model.invoke":
        if (k.denyModel) throw new ChannelError(k.denyModel, "kernel said no");
        return { result: { text: "hi" }, usage: { tokens: 5 }, cost: 2, replay: false };
      case "effect.declare": {
        const kind = String(p.effectKind);
        if (!k.declaredKinds.includes(kind)) {
          throw new ChannelError("SCHED/MANIFEST-INVALID", `effectKind not declared: ${kind}`);
        }
        return { effectId: String(p.effectId), seq: 41 };
      }
      case "ledger.read": {
        const f = (p.filter ?? {}) as Record<string, unknown>;
        // 通道盖章：Cell 侧传来的 runId 一律不参与（这里连收都不该收到）
        if (f.runId !== undefined)
          throw new ChannelError("TRANSPORT/BADFRAME", "runId leaks scope");
        return { events: [{ seq: 1, type: "RUN_STARTED", runId: k.stampedRunId }] };
      }
      default:
        throw new ChannelError("TRANSPORT/BADFRAME", `unexpected op: ${op}`);
    }
  });
  k.cell = cell;
  k.cordis = createCordisCellCtx(cell);
  return k;
}

const last = (k: Kernel, op: string): Record<string, unknown> =>
  k.ops.filter((e) => e.op === op).slice(-1)[0]?.params ?? {};

describe("ctx.model.invoke → model.invoke（边界 #6 的改法地面）", () => {
  it("reqId 是第一个入参，载荷四件套原样进通道；返回体带 replay", async () => {
    const k = kernelRig();
    const out = await k.cordis.model.invoke("req-1", {
      model: "gpt-stub",
      params: { q: 1 },
      estimate: 100,
    });
    expect(out).toMatchObject({ result: { text: "hi" }, cost: 2, replay: false });
    expect(last(k, "model.invoke")).toEqual({
      reqId: "req-1",
      model: "gpt-stub",
      params: { q: 1 },
      estimate: 100,
    });
  });

  it("缺 reqId / 空 reqId / 缺 model / 缺 estimate → 拒绝且**不发帧**（自动生成请求号这条路被堵死）", async () => {
    const k = kernelRig();
    const bad: [unknown, unknown][] = [
      ["", { model: "m", estimate: 1 }],
      [undefined, { model: "m", estimate: 1 }],
      ["req-2", { estimate: 1 }],
      ["req-3", { model: "m" }],
      ["req-4", { model: "m", estimate: -1 }],
    ];
    for (const [reqId, req] of bad) {
      await expect(k.cordis.model.invoke(reqId as string, req as never)).rejects.toBeInstanceOf(
        Error,
      );
      await expect(k.cordis.model.invoke(reqId as string, req as never)).rejects.toThrowError(
        /ADAPTER\/ARGS-REQUIRED/,
      );
    }
    expect(k.ops.filter((e) => e.op === "model.invoke")).toHaveLength(0);
  });

  it("缺 reqId 的理由必须写在错误里（幂等口径是这条改法的实质，不是风格）", async () => {
    const k = kernelRig();
    await expect(k.cordis.model.invoke("", { model: "m", estimate: 1 })).rejects.toThrowError(
      /auto-generated id is always a new request/,
    );
  });

  it("内核拒绝码原样浮出（AUTH/DENIED 与 BUDGET/EXHAUSTED 都不被承接层改写）", async () => {
    const k = kernelRig();
    k.denyModel = "AUTH/DENIED";
    await expect(k.cordis.model.invoke("r-1", { model: "m", estimate: 1 })).rejects.toMatchObject({
      code: "AUTH/DENIED",
    });
    k.denyModel = "BUDGET/EXHAUSTED";
    await expect(k.cordis.model.invoke("r-2", { model: "m", estimate: 1 })).rejects.toMatchObject({
      code: "BUDGET/EXHAUSTED",
    });
  });
});

describe("ctx.effects.declare → effect.declare（边界 #9 的改法地面）", () => {
  it("只提交「动了什么」：effectId 由 Cell 侧指派，compensation 只剩 paramsDigest", async () => {
    const k = kernelRig();
    const view = await k.cordis.effects.declare({
      effectKind: "fs.write.done",
      targetSummary: "/data/x",
      paramsDigest: { bytes: 10 },
    });
    expect(view).toEqual({ effectId: expect.any(String), seq: 41 });
    expect(view.effectId).not.toBe(""); // 插件没给号，照样拿到内核侧的号
    const p = last(k, "effect.declare");
    expect(p.effectKind).toBe("fs.write.done");
    expect(p.targetSummary).toBe("/data/x");
    expect(p.compensation).toEqual({ paramsDigest: { bytes: 10 } });
    // C-M1 的形状证据：插件提交不了补偿动作与幂等口径（那两个量归报关单）
    expect(p.compensation).not.toHaveProperty("actionRef");
    expect(p.compensation).not.toHaveProperty("idempotency");
  });

  it("插件试图自带 effectId / compensation / probeRef → 拒绝（内核拥有的量不接受临场指定）", async () => {
    const k = kernelRig();
    for (const extra of [
      { effectId: "mine" },
      { compensation: { actionRef: "undo" } },
      { probeRef: "peek" },
    ]) {
      await expect(
        k.cordis.effects.declare({ effectKind: "fs.write.done", ...extra } as never),
      ).rejects.toThrowError(/ADAPTER\/ARGS-REQUIRED/);
    }
    expect(k.ops.filter((e) => e.op === "effect.declare")).toHaveLength(0);
  });

  it("缺 effectKind 即拒；未报关的 effectKind 由内核拒（SCHED/MANIFEST-INVALID 原样浮出）", async () => {
    const k = kernelRig();
    await expect(k.cordis.effects.declare({} as never)).rejects.toThrowError(
      /ADAPTER\/ARGS-REQUIRED/,
    );
    await expect(k.cordis.effects.declare({ effectKind: "" })).rejects.toThrowError(
      /ADAPTER\/ARGS-REQUIRED/,
    );
    await expect(k.cordis.effects.declare({ effectKind: "fs.write.other" })).rejects.toMatchObject({
      code: "SCHED/MANIFEST-INVALID",
    });
  });

  it("旧面 effects.reclaim 仍然拒绝——新面不是它的改名（放行了就是静默降级）", () => {
    const k = kernelRig();
    expect(() => k.cordis.effects.reclaim("e-1")).toThrowError(/ADAPTER\/UNSUPPORTED/);
  });
});

describe("ctx.ledger.read → ledger.read（边界 #11/#12/#15 的共同出路）", () => {
  it("过滤面只有 types/seqFrom/seqTo 三位，本 run 由内核盖章", async () => {
    const k = kernelRig();
    const page = (await k.cordis.ledger.read({
      types: ["MODEL_USAGE"],
      seqFrom: 3,
      seqTo: 9,
    })) as { events: unknown[] };
    expect(page.events).toHaveLength(1);
    expect(last(k, "ledger.read")).toEqual({
      filter: { types: ["MODEL_USAGE"], seqFrom: 3, seqTo: 9 },
    });
  });

  it("不带参数 = 读整页；filter 里出现 runId = 拒（不静默丢弃插件的越界企图）", async () => {
    const k = kernelRig();
    await expect(k.cordis.ledger.read()).resolves.toBeDefined();
    await expect(k.cordis.ledger.read({ runId: "other-run" } as never)).rejects.toThrowError(
      /ADAPTER\/ARGS-REQUIRED/,
    );
    await expect(k.cordis.ledger.read({ runId: "other-run" } as never)).rejects.toThrowError(
      /stamped on the channel binding/,
    );
    expect(k.ops.filter((e) => e.op === "ledger.read")).toHaveLength(1); // 两次拒都没发帧
  });
});

describe("宿主端口不假装能跑真链路（04 稿 §2 F7）", () => {
  function hostRig() {
    const ctx = new ContextManager();
    ctx.alloc({ agentId: "a", sessionId: "s" });
    return createCordisCtx({ ctx, ref: { agentId: "a", sessionId: "s", runId: "r" } });
  }

  it("三面一律 ADAPTER/PORT-UNSUPPORTED，且写明去处 = 舱内端口", async () => {
    const cordis = hostRig();
    await expect(cordis.model.invoke("req-1", { model: "m", estimate: 1 })).rejects.toThrowError(
      /ADAPTER\/PORT-UNSUPPORTED/,
    );
    await expect(cordis.effects.declare({ effectKind: "k" })).rejects.toThrowError(
      /ADAPTER\/PORT-UNSUPPORTED/,
    );
    await expect(cordis.ledger.read({})).rejects.toThrowError(/ADAPTER\/PORT-UNSUPPORTED/);
    await expect(cordis.model.invoke("req-1", { model: "m", estimate: 1 })).rejects.toThrowError(
      /createCordisCellCtx/,
    );
  });

  it("注册面不受影响（诊断端口仍是 A1 的增删施加通道）", async () => {
    const cordis = hostRig();
    await expect(cordis.tools.register({ name: "t", handler: () => 1 })).resolves.toMatchObject({
      name: "t",
    });
  });
});
