import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../src/events.js";
import type { SessionEvent } from "../src/session.js";
import { projectSession } from "../src/surface.js";

function ev(runId: string, seq: number, type: LedgerEvent["type"], payload: unknown): LedgerEvent {
  return { seq, ts: 0, runId, sessionId: "s", agentId: "a", type, schemaVersion: 1, payload };
}

function se(runOrdinal: number, runId: string, event: LedgerEvent): SessionEvent {
  return { runOrdinal, runId, sessionRun: runOrdinal, event };
}

const base = (): SessionEvent[] => [
  se(1, "run-1", ev("run-1", 1, "TURN_INPUT", { role: "user", content: "q1" })),
  se(1, "run-1", ev("run-1", 2, "MODEL_MESSAGE", { content: "a1" })),
  se(
    1,
    "run-1",
    ev("run-1", 3, "TOOL_RESULT", {
      round: 1,
      tool: "echo",
      status: "ok",
      durationMs: 1,
      resultDigest: { ok: true },
      toolCallId: "c1",
    }),
  ),
  se(1, "run-1", ev("run-1", 4, "MODEL_MESSAGE", { content: "a2" })),
];

describe("projectSession 压缩折叠（Phase 5 R5 / ADR-0026）", () => {
  it("折叠：遮蔽区间替换为一条 system 摘要；--full 还原原始消息", () => {
    const events: SessionEvent[] = [
      ...base(),
      se(
        2,
        "run-2",
        ev("run-2", 1, "SURFACE_COMPACTED", {
          summary: "S",
          shadowed: [{ from: { runId: "run-1", seq: 1 }, to: { runId: "run-1", seq: 3 } }],
          reason: "manual",
          usageRef: { reqId: "compact:run-2" },
          projectionVersion: 2,
        }),
      ),
      se(2, "run-2", ev("run-2", 2, "TURN_INPUT", { role: "user", content: "q2" })),
    ];
    // 摘要排在被遮蔽区间的起点：摘要 + 保留的最近消息
    expect(projectSession(events)).toEqual([
      { role: "system", content: "S" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q2" },
    ]);
    const full = projectSession(events, { includeCompacted: true });
    expect(full).toHaveLength(5);
    expect(full[0]).toEqual({ role: "user", content: "q1" });
    expect(full.some((m) => m.role === "system")).toBe(false);
  });

  it("嵌套压缩：最新摘要为准，被遮蔽的旧标记连摘要一起丢弃", () => {
    const events: SessionEvent[] = [
      ...base(),
      se(
        2,
        "run-2",
        ev("run-2", 1, "SURFACE_COMPACTED", {
          summary: "OLD",
          shadowed: [{ from: { runId: "run-1", seq: 1 }, to: { runId: "run-1", seq: 3 } }],
          reason: "manual",
          usageRef: { reqId: "c1" },
          projectionVersion: 2,
        }),
      ),
      se(2, "run-2", ev("run-2", 2, "TURN_INPUT", { role: "user", content: "q2" })),
      se(
        3,
        "run-3",
        ev("run-3", 1, "SURFACE_COMPACTED", {
          summary: "NEW",
          shadowed: [{ from: { runId: "run-2", seq: 1 }, to: { runId: "run-2", seq: 2 } }],
          reason: "threshold",
          usageRef: { reqId: "c2" },
          projectionVersion: 2,
        }),
      ),
    ];
    const folded = projectSession(events);
    expect(folded).toEqual([
      { role: "assistant", content: "a2" },
      { role: "system", content: "NEW" },
    ]);
    expect(folded.some((m) => m.content === "OLD")).toBe(false);
  });

  it("区间跨 run：一个标记可以遮蔽多个 run 的前缀", () => {
    const events: SessionEvent[] = [
      se(1, "run-1", ev("run-1", 1, "TURN_INPUT", { role: "user", content: "q1" })),
      se(2, "run-2", ev("run-2", 1, "TURN_INPUT", { role: "user", content: "q2" })),
      se(
        3,
        "run-3",
        ev("run-3", 1, "SURFACE_COMPACTED", {
          summary: "BOTH",
          shadowed: [{ from: { runId: "run-1", seq: 1 }, to: { runId: "run-2", seq: 1 } }],
          reason: "manual",
          usageRef: { reqId: "c" },
          projectionVersion: 2,
        }),
      ),
    ];
    expect(projectSession(events)).toEqual([{ role: "system", content: "BOTH" }]);
  });
});
