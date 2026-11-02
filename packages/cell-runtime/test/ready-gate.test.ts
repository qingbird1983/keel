/**
 * 装载门（ADR-0011）——"插件装载完成之前不受理宿主请求"的四条行为断言。
 *
 * 门的作用面只有**应答时机**：帧照常读取、请求排队、不丢不报错；开闸前若宿主超时，
 * 迟到的响应按既有帧规则丢弃（不静默成功，也不炸通道）。出站方向（Cell→Core）不受门影响，
 * 否则旧插件的 activation 注册会被自己的门挡死。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FrameConn, type FrameError } from "../src/protocol.js";
import { startCell, type CellHandle } from "../src/cell.js";

function rig(loadGate: boolean) {
  const coreIn = new PassThrough();
  const cellIn = new PassThrough();
  const cell: CellHandle = startCell({
    input: cellIn,
    output: coreIn,
    toolCallTimeoutMs: 200,
    loadGate,
  });
  const core = new FrameConn({ input: coreIn, output: cellIn });
  cell.registerTool({ name: "echo", schema: {}, handler: (p) => ({ echoed: p }) });
  return { cell, core, cellIn, coreIn };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no-error";
  } catch (err) {
    return (err as FrameError).code ?? (err as { code?: string }).code ?? "?";
  }
}

describe("装载门：门未开不应答，开闸后同一请求可成", () => {
  it("门内请求超时（不应答）；markReady 后的请求正常得到结果", async () => {
    const { cell, core } = rig(true);
    cell.registerTool({ name: "late", schema: {}, handler: () => ({ ran: "late" }) });
    const timedOut = await codeOf(core.request("tool.exec", { tool: "late" }, 60));
    expect(timedOut).toBe("TRANSPORT/TIMEOUT");

    cell.markReady();
    const r = await core.request<{ status: string; result?: unknown }>(
      "tool.exec",
      { tool: "late" },
      500,
    );
    expect(r.status).toBe("ok");
    expect(r.result).toEqual({ ran: "late" });
  });

  it("门内超时的请求，其迟到响应被丢弃且不破坏通道", async () => {
    const { cell, core } = rig(true);
    const pending = core.request("tool.exec", { tool: "ghost" }, 40);
    await expect(pending).rejects.toMatchObject({ code: "TRANSPORT/TIMEOUT" });
    cell.markReady(); // 迟到响应此刻才写回；FrameConn 找不到在途 id 即丢弃
    await new Promise((r) => setTimeout(r, 30));
    expect(core.isClosed).toBe(false);
    const after = await core.request<{ status: string }>("tool.exec", { tool: "ghost" }, 500);
    expect(after.status).toBe("error"); // 仍然给出明确的未知工具错误，不是通道级故障
  });

  it("未开 gate 时行为与既有一致：markReady 是空操作，请求立即应答", async () => {
    const { cell, core } = rig(false);
    cell.markReady();
    const r = await core.request<{ status: string }>("tool.exec", { tool: "echo" }, 500);
    expect(r.status).toBe("ok");
  });

  it("门不影响出站方向：Cell→Core 请求在门内照样被应答", async () => {
    const { cell, core } = rig(true);
    let served = 0;
    core.serve(async () => {
      served += 1;
      return [{ name: "echo", schemaVersion: 1 }];
    });
    const got = await cell.client.toolDiscover();
    expect(served).toBe(1);
    expect(got).toEqual([{ name: "echo", schemaVersion: 1 }]);
    cell.markReady();
  });

  it("门内舱死（通道关闭）→ 在途请求以通道错回落，不悬挂", async () => {
    const { cell, core, cellIn, coreIn } = rig(true);
    const inFlight = core.request("tool.exec", { tool: "echo" }, 5_000);
    // 真实进程退出时两个方向一起断：舱的 stdout 关（宿主读到 EOF）+ stdin 关（舱读到 EOF）
    coreIn.end();
    cellIn.end();
    await expect(inFlight).rejects.toMatchObject({ code: "TRANSPORT/BADFRAME" });
    await expect(cell.done).resolves.toBeUndefined(); // 舱侧泵也收束（不悬挂）
    cell.markReady(); // 开闸也无从应答：通道已作废（幂等，不抛）
  });
});
