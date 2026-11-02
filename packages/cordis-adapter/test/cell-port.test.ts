/**
 * 舱内端口单测 —— 两半提交与回滚（02 稿 §5.2，ADR-0010 决策 3/4/7）。
 *
 * 现场 = 真 `startCell` + 内存帧通道 + 一个扮演内核的 serve 端（自带 scope 分区与裁决，可在中途翻拒绝）。
 * 断言对象只有三样：执行表能不能跑、内核分区里有什么、承接层给出的视图值——
 * 承接层的内部字段不在断言范围内。
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ChannelError, FrameConn, startCell, type CellHandle } from "@keel/cell-runtime";
import type { CordisCtx } from "../src/index.js";
import { CordisAdapterError } from "../src/index.js";
import { createCordisCellCtx } from "../src/cell-port.js";

interface ExecResult {
  status: string;
  result?: unknown;
  error?: { code?: string };
}

function rig(): {
  cell: CellHandle;
  cordis: CordisCtx;
  ops: string[];
  kernelTools: Map<string, number>;
  setDeny: (v: boolean) => void;
  exec: (tool: string, params?: unknown) => Promise<ExecResult>;
} {
  const kernelTools = new Map<string, number>();
  const ops: string[] = [];
  let deny = false;
  let nextVersion = 7; // 内核指派值：插件端若自算会得到 1/2，用它验证"版本单一事实源"

  const hostToCell = new PassThrough();
  const cellToHost = new PassThrough();
  const cell = startCell({ input: hostToCell, output: cellToHost, toolCallTimeoutMs: 200 });
  const core = new FrameConn({ input: cellToHost, output: hostToCell });
  core.serve(async (op, params) => {
    ops.push(op);
    const p = (params ?? {}) as { name?: unknown; schema?: unknown };
    if (op === "tool.discover") {
      return [...kernelTools].map(([name, schemaVersion]) => ({
        name,
        schemaVersion,
        schema: null,
      }));
    }
    if (op === "tool.register" || op === "tool.remove") {
      if (deny) throw new ChannelError("AUTH/DENIED", `no allow rule matches ${op}`);
      const name = String(p.name);
      if (op === "tool.remove") {
        const existed = kernelTools.has(name);
        kernelTools.delete(name);
        return existed;
      }
      kernelTools.set(name, nextVersion);
      return { name, schemaVersion: nextVersion++ };
    }
    throw new ChannelError("TRANSPORT/BADFRAME", `unexpected op: ${op}`);
  });

  return {
    cell,
    cordis: createCordisCellCtx(cell),
    ops,
    kernelTools,
    setDeny: (v) => {
      deny = v;
    },
    exec: (tool, params) => core.request<ExecResult>("tool.exec", { tool, params }, 500),
  };
}

describe("舱内端口：一次注册写两半", () => {
  it("成功路径：执行表可跑 + 内核可见 + 视图版本 = 内核指派值（插件端不自算）", async () => {
    const { cordis, kernelTools, exec } = rig();
    const view = await cordis.tools.register("alpha", { type: "object" }, (p) => ({ echoed: p }));
    expect(view).toEqual({ name: "alpha", schemaVersion: 7 });
    expect(kernelTools.get("alpha")).toBe(7);
    await expect(exec("alpha", { x: 1 })).resolves.toMatchObject({
      status: "ok",
      result: { echoed: { x: 1 } },
    });
  });

  it("内核拒绝 → 错误码原样浮出，执行表回滚为空（不留半个状态）", async () => {
    const { cell, cordis, kernelTools, setDeny, exec } = rig();
    setDeny(true);
    await expect(cordis.tools.register("alpha", {}, () => 1)).rejects.toMatchObject({
      code: "AUTH/DENIED",
    });
    expect(cell.getTool("alpha")).toBeUndefined();
    expect(kernelTools.size).toBe(0);
    await expect(exec("alpha")).resolves.toMatchObject({
      status: "error",
      error: { code: "CELL/TOOL-UNKNOWN" },
    });
  });

  it("覆盖注册被拒 → 旧 handler 与旧可见条目都还在（既不留新版空壳，也不丢旧版）", async () => {
    const { cell, cordis, kernelTools, setDeny, exec } = rig();
    await cordis.tools.register("alpha", { v: 1 }, () => "first");
    expect(kernelTools.get("alpha")).toBe(7);

    setDeny(true);
    await expect(cordis.tools.register("alpha", { v: 2 }, () => "second")).rejects.toMatchObject({
      code: "AUTH/DENIED",
    });
    expect(cell.getTool("alpha")).toBeDefined();
    await expect(exec("alpha")).resolves.toMatchObject({ status: "ok", result: "first" });
    expect(kernelTools.get("alpha")).toBe(7); // 内核侧版本也没被"顺手"改动
  });

  it("无 handler 的注册直接拒绝，且一个通道帧都不发（从源头堵掉「可见而不可执行」）", async () => {
    const { cordis, ops, exec } = rig();
    await expect(cordis.tools.register({ name: "ghost" })).rejects.toBeInstanceOf(
      CordisAdapterError,
    );
    expect(ops).not.toContain("tool.register");
    await expect(exec("ghost")).resolves.toMatchObject({ error: { code: "CELL/TOOL-UNKNOWN" } });
  });

  it("撤名以内核为准：内核说有 / 说没有，本地都撤（不留可执行而不可见的暗桩）", async () => {
    const { cell, cordis, exec } = rig();
    await cordis.tools.register("alpha", {}, () => 1);
    expect(await cordis.tools.remove("alpha")).toBe(true);
    expect(cell.getTool("alpha")).toBeUndefined();

    cell.registerTool({ name: "orphan", schema: null, handler: () => 1 }); // 本地有、内核没有
    expect(await cordis.tools.remove("orphan")).toBe(false);
    expect(cell.getTool("orphan")).toBeUndefined();
    await expect(exec("orphan")).resolves.toMatchObject({ error: { code: "CELL/TOOL-UNKNOWN" } });
  });

  it("内核拒绝撤名 → 本地不动（拒绝不该顺带改掉插件手里在跑的工具）", async () => {
    const { cell, cordis, setDeny } = rig();
    await cordis.tools.register("alpha", {}, () => "keep");
    setDeny(true);
    await expect(cordis.tools.remove("alpha")).rejects.toMatchObject({ code: "AUTH/DENIED" });
    expect(cell.getTool("alpha")).toBeDefined();
  });

  it("list = 内核视图，且只回名字与版本（schema 与 handler 都不外泄）", async () => {
    const { cordis, kernelTools } = rig();
    kernelTools.set("peer", 3); // 同 scope 内其他来源的条目
    await cordis.tools.register("mine", { secret: true }, () => 1);
    expect(await cordis.tools.list()).toEqual([
      { name: "peer", schemaVersion: 3 },
      { name: "mine", schemaVersion: 7 },
    ]);
  });

  it("handler 的第二参数拿回旧形状 ctx（旧代码继续用它注册与查表，不需要任何 Keel 符号）", async () => {
    const { cordis, exec } = rig();
    await cordis.tools.register("alpha", {}, async (_p, ctx) => (await ctx.tools.list()).length);
    await expect(exec("alpha")).resolves.toMatchObject({ status: "ok", result: 1 });
  });

  it("未映射旧面在舱内同样逐项拒绝（与宿主端口共用一张承接面表）", () => {
    const { cordis } = rig();
    expect(() => cordis.share.get("k")).toThrowError(/ADAPTER\/UNSUPPORTED/);
    expect(() => cordis.bus.emit("t")).toThrowError(/ADAPTER\/UNSUPPORTED/);
    expect(() => cordis.hooks.register("h")).toThrowError(/ADAPTER\/UNSUPPORTED/);
    expect(() => cordis.llm.chat({})).toThrowError(/ADAPTER\/UNSUPPORTED/);
  });
});
