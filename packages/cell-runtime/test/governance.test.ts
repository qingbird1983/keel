import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { startCell, type CellTool } from "../src/cell.js";
import { FrameConn } from "../src/protocol.js";
import { canonicalDigest, type CellGovernancePlan } from "../src/governance.js";

/** 内存 rig：cell 进程体 + 模拟 Core 侧（同进程双 FrameConn）。 */
function rig(toolCallTimeoutMs = 500, governance?: CellGovernancePlan) {
  const coreIn = new PassThrough();
  const cellIn = new PassThrough();
  const cell = startCell({ input: cellIn, output: coreIn, toolCallTimeoutMs, governance });
  const core = new FrameConn({ input: coreIn, output: cellIn });
  return { cell, core };
}

const PLAN: CellGovernancePlan = {
  version: 1,
  tools: {
    write_file: {
      guard: { cap: "fs.write", from: "path", prefix: "fs:" },
      effects: [{ kind: "file.write", targetFields: ["path"], digestFields: ["path", "content"] }],
    },
  },
};

type Call = { op: string; params: unknown };

function writeTool(handler: CellTool["handler"]): CellTool {
  return { name: "write_file", schema: {}, handler };
}

describe("Cell 治理切面：拦截器链（G1~G8，ADR-0015）", () => {
  it("G1：无治理计划 → 不发通道请求，handler 收到空 effects（老路径）", async () => {
    const { cell, core } = rig();
    const calls: Call[] = [];
    core.serve(async (op, params) => {
      calls.push({ op, params });
      return null;
    });
    const seen: unknown[] = [];
    cell.registerTool(
      writeTool((params, ctx) => {
        seen.push(ctx.effects);
        return { echoed: params };
      }),
    );
    const r = await core.request<{ status: string; result: unknown }>(
      "tool.exec",
      { tool: "write_file", params: { path: "/tmp/x", content: "hi" } },
      500,
    );
    expect(r.status).toBe("ok");
    expect(calls).toHaveLength(0);
    expect(seen[0]).toEqual([]);
  });

  it("G2/G3/G5：guard → declare → handler，payload 与 ctx.effects 一致", async () => {
    const { cell, core } = rig(500, PLAN);
    const calls: Call[] = [];
    core.serve(async (op, params) => {
      calls.push({ op, params });
      if (op === "auth.check") return { allowed: true };
      if (op === "effect.declare") return { effectId: "e-1", seq: 11 };
      throw new Error(`unexpected op ${op}`);
    });
    const seen: unknown[] = [];
    cell.registerTool(
      writeTool((params, ctx) => {
        calls.push({ op: "handler", params });
        seen.push(ctx.effects);
        return { path: (params as { path: string }).path };
      }),
    );
    cell.markReady();

    const r = await core.request<{ status: string; result: unknown }>(
      "tool.exec",
      { tool: "write_file", params: { path: "/tmp/x", content: "hi" } },
      500,
    );
    expect(r.status).toBe("ok");
    expect(calls.map((c) => c.op)).toEqual(["auth.check", "effect.declare", "handler"]);
    expect(calls[0].params).toEqual({ action: "fs.write", resource: "fs:/tmp/x" });
    expect(calls[1].params).toMatchObject({
      effectKind: "file.write",
      targetSummary: { path: "/tmp/x" },
      compensation: { paramsDigest: canonicalDigest({ path: "/tmp/x", content: "hi" }) },
    });
    expect(seen[0]).toEqual([
      {
        kind: "file.write",
        effectId: "e-1",
        seq: 11,
        targetSummary: { path: "/tmp/x" },
        paramsDigest: canonicalDigest({ path: "/tmp/x", content: "hi" }),
      },
    ]);
  });

  it("G2：守卫拒绝 → AUTH/DENIED，handler 零调用，不声明效果", async () => {
    const { cell, core } = rig(500, PLAN);
    const ops: string[] = [];
    core.serve(async (op) => {
      ops.push(op);
      if (op === "auth.check") return { allowed: false, reason: "no rule" };
      throw new Error(`unexpected op ${op}`);
    });
    const handler = vi.fn(() => ({ ok: true }));
    cell.registerTool(writeTool(handler));

    const r = await core.request<{ status: string; error?: { code?: string } }>(
      "tool.exec",
      { tool: "write_file", params: { path: "/tmp/x", content: "hi" } },
      500,
    );
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("AUTH/DENIED");
    expect(handler).not.toHaveBeenCalled();
    expect(ops).toEqual(["auth.check"]);
  });

  it("G4：声明被拒 → 错误码透传，handler 零调用", async () => {
    const { cell, core } = rig(500, PLAN);
    core.serve(async (op) => {
      if (op === "auth.check") return { allowed: true };
      if (op === "effect.declare") {
        throw Object.assign(new Error("template mismatch"), { code: "SCHED/MANIFEST-INVALID" });
      }
      throw new Error(`unexpected op ${op}`);
    });
    const handler = vi.fn(() => ({ ok: true }));
    cell.registerTool(writeTool(handler));

    const r = await core.request<{ status: string; error?: { code?: string } }>(
      "tool.exec",
      { tool: "write_file", params: { path: "/tmp/x", content: "hi" } },
      500,
    );
    expect(r).toMatchObject({ status: "error", error: { code: "SCHED/MANIFEST-INVALID" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("G6：缺 targetFields 字段 → TRANSPORT/BADFRAME，handler 零调用", async () => {
    const { cell, core } = rig(500, PLAN);
    core.serve(async (op) => {
      if (op === "auth.check") return { allowed: true };
      throw new Error(`unexpected op ${op}`);
    });
    const handler = vi.fn(() => ({ ok: true }));
    cell.registerTool(writeTool(handler));

    const r = await core.request<{ status: string; error?: { code?: string } }>(
      "tool.exec",
      { tool: "write_file", params: { content: "hi" } },
      500,
    );
    expect(r).toMatchObject({ status: "error", error: { code: "TRANSPORT/BADFRAME" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("G7：计划点名未注册工具 → markReady 抛错（装载可见失败）", () => {
    const { cell } = rig(500, PLAN);
    expect(() => cell.markReady()).toThrow(/unregistered tool: write_file/);
  });

  it("G8：旧 handler 只收 (params) 与 (params,{client}) 均可运行", async () => {
    const { cell, core } = rig(500, PLAN);
    core.serve(async (op) => {
      if (op === "auth.check") return { allowed: true };
      if (op === "effect.declare") return { effectId: "e-1", seq: 1 };
      throw new Error(`unexpected op ${op}`);
    });
    cell.registerTool(writeTool((params) => ({ pure: params })));
    cell.markReady();
    const r = await core.request<{ status: string; result: unknown }>(
      "tool.exec",
      { tool: "write_file", params: { path: "/tmp/x", content: "hi" } },
      500,
    );
    expect(r.status).toBe("ok");
    expect(r.result).toEqual({ pure: { path: "/tmp/x", content: "hi" } });
  });
});

describe("治理摘要：跨进程可复现", () => {
  it("键序无关（递归排序）", () => {
    expect(canonicalDigest({ b: 1, a: { d: 2, c: 3 } })).toEqual(
      canonicalDigest({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalDigest({ b: 1 }).alg).toBe("sha256");
    expect(canonicalDigest({ b: 1 }).hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
