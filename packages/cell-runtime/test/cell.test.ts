import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FrameConn, type FrameError } from "../src/protocol.js";
import { startCell, type CellTool } from "../src/cell.js";

/** 内存在场测试：cell 进程体 + 模拟 Core 侧（同进程双 FrameConn，契约 §3.1 帧通道）。 */
function rig(toolCallTimeoutMs = 200) {
  const coreIn = new PassThrough(); // core 读
  const cellIn = new PassThrough(); // cell 读
  const cell = startCell({ input: cellIn, output: coreIn, toolCallTimeoutMs });
  const core = new FrameConn({ input: coreIn, output: cellIn });
  return { cell, core, cellIn, close: () => void 0 };
}

/** 从 FrameConn 错误里取契约错误码（serve 侧错误经帧回落）。 */
async function errCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no-error";
  } catch (err) {
    return (err as FrameError).code ?? (err as { code?: string }).code ?? "?";
  }
}

describe("Cell 进程体：tool.exec", () => {
  it("ok：工具执行结果与耗时返回", async () => {
    const { cell, core } = rig();
    const tool: CellTool = { name: "echo", schema: {}, handler: (p) => ({ echoed: p }) };
    cell.registerTool(tool);
    const r = await core.request<{ status: string; result?: unknown; durationMs: number }>(
      "tool.exec",
      { tool: "echo", params: { x: 1 } },
      500,
    );
    expect(r.status).toBe("ok");
    expect(r.result).toEqual({ echoed: { x: 1 } });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("未知工具 → error + CELL/TOOL-UNKNOWN", async () => {
    const { core } = rig();
    const r = await core.request<{ status: string; error?: { code?: string } }>(
      "tool.exec",
      { tool: "ghost" },
      500,
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("CELL/TOOL-UNKNOWN");
  });

  it("handler 抛错 → error + 原错误码透传", async () => {
    const { cell, core } = rig();
    cell.registerTool({
      name: "bad",
      schema: {},
      handler: () => {
        const e = new Error("tool blew up") as Error & { code?: string };
        e.code = "TOOL/DISK-ON-FIRE";
        throw e;
      },
    });
    const r = await core.request<{ status: string; error?: { code?: string } }>(
      "tool.exec",
      { tool: "bad" },
      500,
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("TOOL/DISK-ON-FIRE");
  });

  it("toolCallTimeoutMs 硬强制 → timeout + TRANSPORT/TIMEOUT（C-D3）", async () => {
    const { cell, core } = rig(30);
    cell.registerTool({
      name: "wedged",
      schema: {},
      // 永不落定的 promise 不持有事件循环，测试可干净收束
      handler: () => new Promise<void>(() => {}),
    });
    const r = await core.request<{ status: string; error?: { code?: string }; durationMs: number }>(
      "tool.exec",
      { tool: "wedged" },
      500,
    );
    expect(r.status).toBe("timeout");
    expect(r.error?.code).toBe("TRANSPORT/TIMEOUT");
    expect(r.durationMs).toBeGreaterThanOrEqual(25);
  });
});

describe("Cell 进程体：CellClient（发起端通道）", () => {
  it("effect.declare 携带 effectId 与补偿语义（EFFECT_DECLARED 发起端）", async () => {
    const { cell, core } = rig();
    let captured: Record<string, unknown> | null = null;
    core.serve(async (op, params) => {
      if (op !== "effect.declare") throw new Error(`unexpected op ${op}`);
      captured = params as Record<string, unknown>;
      return { effectId: (captured as { effectId: string }).effectId, seq: 7 };
    });
    const tool: CellTool = {
      name: "declarer",
      schema: {},
      handler: (_p, ctx) =>
        ctx.client.declareEffect({
          effectKind: "webfetch.request-sent",
          compensation: { actionRef: "compensations/cancelOrMark", idempotency: "keyed" },
        }),
    };
    cell.registerTool(tool);
    const r = await core.request("tool.exec", { tool: "declarer" }, 500);
    expect(r).toMatchObject({ status: "ok" });
    expect(captured).toMatchObject({
      effectKind: "webfetch.request-sent",
      compensation: { actionRef: "compensations/cancelOrMark", idempotency: "keyed" },
    });
    expect((captured as unknown as { effectId?: string }).effectId).toBeTruthy();
  });

  it("auth.check / tool.discover 请求形与透传", async () => {
    const { cell, core } = rig();
    const seen: Array<[string, unknown]> = [];
    core.serve(async (op, params) => {
      seen.push([op, params]);
      if (op === "auth.check") return { allowed: false, reason: "no rule" };
      if (op === "tool.discover") return [{ name: "t", schemaVersion: 1, schema: {} }];
      return null;
    });
    let authResult: { allowed?: boolean } | null = null;
    let discover: unknown[] | null = null;
    cell.registerTool({
      name: "probe",
      schema: {},
      handler: async (_p, ctx) => {
        authResult = await ctx.client.authCheck("tool.invoke", "t");
        discover = await ctx.client.toolDiscover();
        return null;
      },
    });
    await core.request("tool.exec", { tool: "probe" }, 500);
    expect(authResult).toEqual({ allowed: false, reason: "no rule" });
    expect(discover).toHaveLength(1);
    expect(seen.map(([op]) => op)).toEqual(["auth.check", "tool.discover"]);
  });

  it("ledger.read 只发 filter（runId 由 Core 侧盖章，本进程不持有）", async () => {
    const { cell, core } = rig();
    const params: { current: { filter?: Record<string, unknown> } | null } = { current: null };
    core.serve(async (op, p) => {
      if (op === "ledger.read") params.current = p as { filter: Record<string, unknown> };
      return { events: [], nextCursor: null };
    });
    cell.registerTool({
      name: "reader",
      schema: {},
      handler: (_p, ctx) => ctx.client.ledgerRead({ types: ["DECISION"] }),
    });
    await core.request("tool.exec", { tool: "reader" }, 500);
    expect(params.current?.filter).toEqual({ types: ["DECISION"] });
  });
});

describe("Cell 进程体：迁移钩（A5）", () => {
  it("migrate：注册的迁移函数变换旧状态", async () => {
    const { cell, core } = rig();
    cell.setMigration((old: unknown) => ({ ...(old as object), upgraded: true }));
    await expect(core.request("cell.migrate", { oldState: { v: 1 } }, 500)).resolves.toEqual({
      v: 1,
      upgraded: true,
    });
  });

  it("未注册迁移钩 → CELL/MIGRATION-MISSING（装配器据此回退）", async () => {
    const { core } = rig();
    expect(await errCode(core.request("cell.migrate", { oldState: {} }, 500))).toBe(
      "CELL/MIGRATION-MISSING",
    );
  });

  it("未知 op → CELL/OP-UNKNOWN", async () => {
    const { core } = rig();
    expect(await errCode(core.request("cell.boot", {}, 500))).toBe("CELL/OP-UNKNOWN");
  });
});
