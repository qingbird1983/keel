import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ChannelError,
  FrameConn,
  TRANSPORT_BADFRAME,
  TRANSPORT_TIMEOUT,
  toFrameError,
  type EventFrame,
} from "../src/protocol.js";

/** 内存双工：两端各持一个 FrameConn（standards/05 §3：不依赖真实进程/网络）。 */
function pairedConns() {
  const aIn = new PassThrough(); // a 读（= b 的输出侧）
  const bIn = new PassThrough(); // b 读（= a 的输出侧）
  const a = new FrameConn({ input: aIn, output: bIn });
  const b = new FrameConn({ input: bIn, output: aIn });
  const close = () => {
    aIn.end();
    bIn.end();
  };
  return { a, b, aIn, bIn, close };
}

function writeLine(s: { write: (c: string) => unknown }, frame: unknown): void {
  s.write(JSON.stringify(frame) + "\n");
}

describe("FrameConn 请求/响应", () => {
  it("roundtrip：请求被对端 serve 并响应", async () => {
    const { a, b, close } = pairedConns();
    b.serve(async (op, params) => (op === "ping" ? { pong: params } : null));
    await expect(a.request<{ pong: string }>("ping", { x: 1 }, 500)).resolves.toEqual({
      pong: { x: 1 },
    });
    close();
  });

  it("serve 抛 ChannelError → 响应错误帧；request 按码拒绝", async () => {
    const { a, b, close } = pairedConns();
    b.serve(async () => {
      throw new ChannelError("AUTH/DENIED", "no", { r: 1 });
    });
    await expect(a.request("op", {}, 500)).rejects.toMatchObject({
      code: "AUTH/DENIED",
      detail: { r: 1 },
    });
    close();
  });

  it("serve 抛普通 Error → 兜底码 CELL/INTERNAL", async () => {
    const { a, b, close } = pairedConns();
    b.serve(async () => {
      throw new Error("boom");
    });
    await expect(a.request("op", {}, 500)).rejects.toMatchObject({ code: "CELL/INTERNAL" });
    close();
  });

  it("超时 → TRANSPORT/TIMEOUT，且迟到的响应被丢弃", async () => {
    const { a, b, aIn, close } = pairedConns();
    // 对端收到但永不响应（永不落定的 promise 不持有事件循环）
    b.serve(() => new Promise<never>(() => {}));
    await expect(a.request("slow", {}, 20)).rejects.toMatchObject({ code: TRANSPORT_TIMEOUT });
    // 迟到响应直写 a 的输入侧：不应 resolve 已超时的请求，也不影响后续
    writeLine(aIn, { id: "r1", ok: true, result: "late" });
    b.serve(async () => "fast");
    await expect(a.request("fast", {}, 500)).resolves.toBe("fast");
    close();
  });
});

describe("FrameConn 故障路径", () => {
  it("坏帧 → 通道作废，在途请求以 TRANSPORT/BADFRAME 回落", async () => {
    const { a, aIn, close } = pairedConns();
    const pending = a.request("op", {}, 5000);
    aIn.write("this is not json\n");
    await expect(pending).rejects.toMatchObject({ code: TRANSPORT_BADFRAME });
    await expect(a.request("op2", {}, 100)).rejects.toMatchObject({ code: TRANSPORT_BADFRAME });
    close();
  });

  it("对端关闭 → 在途请求以 TRANSPORT/BADFRAME 回落，pump 结束", async () => {
    const { a, aIn, close } = pairedConns();
    const pending = a.request("op", {}, 5000);
    aIn.end(); // 对端 stdout 结束 = 本端输入流结束
    await expect(pending).rejects.toMatchObject({ code: TRANSPORT_BADFRAME });
    await a.done;
    close();
  });

  it("关闭后的新请求立即失败（不发帧）", async () => {
    const { a, aIn, close } = pairedConns();
    aIn.end();
    await a.done;
    await expect(a.request("op", {}, 500)).rejects.toMatchObject({ code: TRANSPORT_BADFRAME });
    close();
  });
});

describe("FrameConn 事件与帧形路由", () => {
  it("事件帧分发到 onEvent；请求/响应互不误路由", async () => {
    const { a, b, aIn, close } = pairedConns();
    const got: EventFrame[] = [];
    a.onEvent((ev) => got.push(ev));
    b.serve(async () => "ok");
    const p = a.request("op", {}, 500);
    writeLine(aIn, { ev: "ROUND_STARTED", seq: 1 });
    await expect(p).resolves.toBe("ok");
    expect(got).toEqual([{ ev: "ROUND_STARTED", seq: 1 }]);
    close();
  });
});

describe("toFrameError", () => {
  it("ChannelError 带 detail；带 code 字段的错误透传；其余兜底", () => {
    expect(toFrameError(new ChannelError("X/Y", "m", { d: 1 }))).toEqual({
      code: "X/Y",
      message: "[X/Y] m",
      detail: { d: 1 },
    });
    expect(toFrameError({ code: "CUSTOM", message: "z" }).code).toBe("CUSTOM");
    expect(toFrameError("plain").code).toBe("CELL/INTERNAL");
  });
});
