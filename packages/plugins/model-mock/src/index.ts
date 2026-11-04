/**
 * `model-mock` —— `kind:"model"` 的确定性剧本实现（Phase 4 切片③，02 稿 M7）。
 *
 * 定位：进 CI、承载 D2/D4/D6 的全部机械断言。它**只报用量**（三桶），不报费用——
 * 费用由 Core 按 manifest 价格表算（协议违规会被网关拒绝）。
 *
 * 剧本形状照 DeepSeek 的实测（research/02 §4/§5）：usage 挂在最后一个内容块（这里每片都给
 * **累计值**，断流时最后一片仍可计价）；模块内可选空闲看门狗按分片到达 rearm，触发即抛错
 * （网关按断流口径结算已产出部分）。
 *
 * 零依赖、不读进程环境：密钥只经 `create({ secrets })` 注入面，且 mock 根本不需要真密钥。
 */

export interface MockModelSection {
  provider: string;
  protocol: "mock" | "http-sse";
  models: string[];
  auth?: { ref: string };
  timeouts?: { idleMs?: number };
}

export interface MockUsage {
  inputCached: number;
  inputUncached: number;
  output: number;
}

export interface CreateInput {
  model: MockModelSection;
  secrets: { resolve(ref: string): string | undefined };
}

export interface MockParams {
  /** 剧本：默认 ok；throw = 上游抛；slow = 延迟返回；no-usage = 不报用量。 */
  scenario?: "ok" | "throw" | "slow" | "no-usage";
  /** slow 剧本的延迟（毫秒）。 */
  delayMs?: number;
  /** 流式片数（缺省 3）。 */
  chunks?: number;
  /** 每片之间的延迟（毫秒；超过 idleMs 即由看门狗中止）。 */
  chunkDelayMs?: number;
  /** 出第 N 片后抛错（断流剧本）。 */
  chunksBeforeThrow?: number;
  /** 第一片之后停顿（毫秒；用于触发模块内的空闲看门狗）。 */
  pauseAfterFirstMs?: number;
  /** 非流式回答正文。 */
  content?: string;
  /** 非流式回答的思考内容（回传形状的证据）。 */
  reasoningContent?: string;
}

/** 每片报一次**累计**三桶：最后一片即终值，断流时最后一片仍可计价。 */
export const USAGE_PER_CHUNK: MockUsage = {
  inputCached: 1_000_000,
  inputUncached: 1_000_000,
  output: 1_000_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

function asParams(params: unknown): MockParams {
  return (params ?? {}) as MockParams;
}

function cumulative(chunks: number): MockUsage {
  return {
    inputCached: USAGE_PER_CHUNK.inputCached * chunks,
    inputUncached: USAGE_PER_CHUNK.inputUncached * chunks,
    output: USAGE_PER_CHUNK.output * chunks,
  };
}

/**
 * 空闲看门狗（02 稿 M5 第 2 条）：等待超过 `idleMs` 即视为上游卡死，抛错让网关按断流结算。
 * `idleMs` 由 manifest 声明（≤ 契约总时限），模块不自己发明数字。
 */
async function waitOrAbort(ms: number, idleMs: number | undefined): Promise<void> {
  if (idleMs === undefined || ms <= idleMs) return await sleep(ms);
  await sleep(idleMs);
  throw new Error(`idle watchdog fired: no chunk within ${idleMs}ms`);
}

export function create({ model }: CreateInput) {
  const idleMs = model.timeouts?.idleMs;

  return {
    async invoke(req: { model: string; params: unknown }) {
      const p = asParams(req.params);
      if (p.scenario === "throw") throw new Error("mock upstream failure");
      if (p.scenario === "slow") await waitOrAbort(p.delayMs ?? 50, idleMs);
      const result = {
        role: "assistant" as const,
        content: p.content ?? "mock answer",
        ...(p.reasoningContent !== undefined ? { reasoningContent: p.reasoningContent } : {}),
      };
      if (p.scenario === "no-usage") return { result, usage: undefined };
      return { result, usage: cumulative(1) };
    },

    async *stream(req: { model: string; params: unknown }) {
      const p = asParams(req.params);
      const n = Math.max(1, Math.min(64, Math.trunc(p.chunks ?? 3) || 1));
      const boom = p.chunksBeforeThrow;
      for (let i = 1; i <= n; i++) {
        if (i === 2 && p.pauseAfterFirstMs !== undefined) {
          await waitOrAbort(p.pauseAfterFirstMs, idleMs);
        } else if (p.chunkDelayMs !== undefined) {
          await waitOrAbort(p.chunkDelayMs, idleMs);
        }
        if (boom !== undefined && i > boom) throw new Error("mock upstream died mid-stream");
        yield { chunk: { seq: i, text: `mock-${i}` }, usage: cumulative(i) };
      }
    },
  };
}
