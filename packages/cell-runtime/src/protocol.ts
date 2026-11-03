/**
 * stdio JSON 行帧协议 —— 契约 §3.1（唯一通道；ADR-0001 语言解耦点）。
 *
 * 帧三类（同向复用一条通道，按帧形路由）：
 * - 请求：{"id","op","params","timeoutMs"}（一切请求必须携带 timeoutMs，§3.1）
 * - 响应：{"id","ok":true,"result"} | {"id","ok":false,"error":{code,message,detail}}
 * - 事件：{"ev","seq",...}（单向通知，即账本事件按订阅分发；接收方不得反向写）
 *
 * 超时 → TRANSPORT/TIMEOUT（结果未知，调用方不得假设未发生，契约 §6）；
 * 坏帧 / 对端关闭 → 通道作废，在途请求一律以 TRANSPORT/BADFRAME 回落（fail-stop）。
 * 本包零运行时依赖：错误模型自带（不依赖 @keel/core 的 KeelError）。
 */

/** 通道错误：code 为契约 §6 错误码或 CELL/... 域（与 core 的 KeelError 同形，跨包零依赖）。 */
export class ChannelError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "ChannelError";
    this.code = code;
    this.detail = detail;
  }
}

export const TRANSPORT_TIMEOUT = "TRANSPORT/TIMEOUT";
export const TRANSPORT_BADFRAME = "TRANSPORT/BADFRAME";

/** 请求帧错误体（契约 §3.1）。 */
export interface FrameError {
  code: string;
  message: string;
  detail?: unknown;
}

/** 流绑定：input = 对端→本端字节流；output = 本端→对端（node 流与内存 duplex 皆可）。 */
export interface ConnStreams {
  input: AsyncIterable<Uint8Array>;
  output: { write(chunk: string): unknown };
}

/** 请求帧（发方视图）。 */
export interface RequestFrame<P = unknown> {
  id: string;
  op: string;
  params: P;
  timeoutMs: number;
}

/** 响应帧。 */
export interface ResponseFrame {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: FrameError;
}

/** 事件帧（单向通知）。 */
export interface EventFrame {
  ev: string;
  [k: string]: unknown;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 帧错误 → 可跨通道序列化的普通对象（serve 侧异常统一出口）。 */
export function toFrameError(err: unknown): FrameError {
  // 本包不依赖 @keel/core，于是 Core 侧的 KeelError 在这里是"带 code/detail 的结构化对象"。
  // detail 必须照样穿过去：调用方看到的不能只是"失败了"，还要有"失败于哪一种/第几片/结了多少钱"
  // （切片⑤ B7④ 的真进程测试就是在这一行了断过一次——detail 被丢，舱内只剩一个码）。
  const code =
    typeof (err as { code?: unknown })?.code === "string"
      ? (err as { code: string }).code
      : "CELL/INTERNAL";
  const detail = (err as { detail?: unknown })?.detail;
  const message = err instanceof Error ? err.message : String(err);
  return { code, message, ...(detail !== undefined ? { detail } : {}) };
}

/**
 * 双向帧连接：双方各自持有一个实例（请求/响应/事件同通道复用，按帧形路由）。
 * - request(op, params, timeoutMs)：发请求并等待响应；id 连接内自增唯一。
 * - serve(handler)：处理对端请求；handler 抛错一律转错误响应（不落通道状态）。
 * - onEvent(cb)：分发事件帧。
 * - 任何坏帧或对端关闭：作废通道，拒绝全部在途请求（TRANSPORT/BADFRAME）。
 */
export class FrameConn {
  private readonly streams: ConnStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly eventHandlers = new Set<(ev: EventFrame) => void>();
  private seq = 0;
  private closed = false;
  private readonly pump: Promise<void>;
  private serveHandler: ((op: string, params: unknown) => Promise<unknown>) | null = null;

  constructor(streams: ConnStreams) {
    this.streams = streams;
    this.pump = this.pumpInput();
  }

  /** 泵结束（通道关闭）——测试与 Supervisor 据此感知对端退出。 */
  get done(): Promise<void> {
    return this.pump;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onEvent(cb: (ev: EventFrame) => void): void {
    this.eventHandlers.add(cb);
  }

  /** 注册对端请求处理器（每连接一个；重复注册覆盖）。 */
  serve(handler: (op: string, params: unknown) => Promise<unknown>): void {
    this.serveHandler = handler;
  }

  /** 发请求；timeoutMs 必填（契约 §3.1：一切请求必须携带，缺省语义由调用方按 §7 表给值）。 */
  request<T = unknown>(op: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ChannelError(TRANSPORT_BADFRAME, "channel closed", { op }));
    }
    const id = `r${++this.seq}`;
    let resolve!: (v: unknown) => void;
    let reject!: (e: Error) => void;
    const p = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new ChannelError(TRANSPORT_TIMEOUT, `request timed out: ${op}`, { op, timeoutMs }));
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    try {
      this.streams.output.write(
        JSON.stringify({ id, op, params, timeoutMs } satisfies RequestFrame) + "\n",
      );
    } catch (err) {
      this.break(`write failed: ${String(err)}`);
      return Promise.reject(new ChannelError(TRANSPORT_BADFRAME, "channel closed", { op }));
    }
    return p as Promise<T>;
  }

  /** 响应对端请求（内部；由 pump 调）。 */
  private async respond(frame: RequestFrame): Promise<void> {
    let response: ResponseFrame;
    if (!this.serveHandler) {
      response = {
        id: frame.id,
        ok: false,
        error: { code: TRANSPORT_BADFRAME, message: "no serve handler" },
      };
    } else {
      try {
        response = {
          id: frame.id,
          ok: true,
          result: await this.serveHandler(frame.op, frame.params),
        };
      } catch (err) {
        response = { id: frame.id, ok: false, error: toFrameError(err) };
      }
    }
    if (this.closed) return;
    try {
      this.streams.output.write(JSON.stringify(response) + "\n");
    } catch {
      this.break("write failed on response");
    }
  }

  /** 通道作废：拒绝全部在途请求，后续 request 一律立即失败。 */
  private break(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ChannelError(TRANSPORT_BADFRAME, `channel broken: ${reason}`));
    }
    this.pending.clear();
  }

  private async pumpInput(): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of this.streams.input) {
        buffer += Buffer.from(chunk).toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) this.handleLine(line);
        }
      }
      this.break("peer closed channel");
    } catch (err) {
      this.break(`input failed: ${String(err)}`);
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.break(`bad frame: ${line.slice(0, 80)}`);
      return;
    }
    // 帧形路由（契约 §3.1）：响应带 ok；请求带 op；事件带 ev
    if (typeof frame.ok === "boolean" && typeof frame.id === "string") {
      const p = this.pending.get(frame.id);
      if (!p) return; // 迟到响应（请求已超时移除）：丢弃
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.result);
      else {
        const e = (frame.error ?? {}) as Partial<FrameError>;
        p.reject(
          new ChannelError(e.code ?? TRANSPORT_BADFRAME, e.message ?? "request failed", e.detail),
        );
      }
      return;
    }
    if (typeof frame.ev === "string") {
      for (const cb of this.eventHandlers) cb(frame as EventFrame);
      return;
    }
    if (typeof frame.op === "string" && typeof frame.id === "string") {
      void this.respond(frame as unknown as RequestFrame);
      return;
    }
    this.break(`bad frame shape: ${line.slice(0, 80)}`);
  }
}
