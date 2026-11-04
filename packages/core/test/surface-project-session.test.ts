import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../src/events.js";
import { SURFACE_PROJECTION_VERSION, projectSession } from "../src/surface.js";
import type { SessionEvent } from "../src/session.js";

function ev(runId: string, seq: number, type: LedgerEvent["type"], payload: unknown): LedgerEvent {
  return { seq, ts: 0, runId, sessionId: "s", agentId: "a", type, schemaVersion: 1, payload };
}

function se(runOrdinal: number, runId: string, event: LedgerEvent): SessionEvent {
  return { runOrdinal, runId, sessionRun: runOrdinal, event };
}

describe("projectSession（Phase 5 R4：跨 run 表面投影）", () => {
  it("版本 2：规则集包含跨 run 拼接（压缩折叠随切片④）", () => {
    expect(SURFACE_PROJECTION_VERSION).toBe(2);
  });

  it("按会话顺序投影白名单，治理事件永不进入", () => {
    const events: SessionEvent[] = [
      se(1, "run-1", ev("run-1", 1, "TURN_INPUT", { role: "user", content: "q1" })),
      se(1, "run-1", ev("run-1", 2, "DECISION", { round: 1, summary: {}, basedOn: [] })),
      se(1, "run-1", ev("run-1", 3, "MODEL_MESSAGE", { content: "a1", reasoningContent: "r1" })),
      se(2, "run-2", ev("run-2", 1, "TURN_INPUT", { role: "user", content: "q2" })),
      se(2, "run-2", ev("run-2", 2, "AUTH_DENIED", { reason: "nope" })),
      se(
        2,
        "run-2",
        ev("run-2", 3, "TOOL_RESULT", {
          round: 1,
          tool: "echo",
          status: "ok",
          durationMs: 1,
          resultDigest: { ok: true },
          toolCallId: "c1",
        }),
      ),
    ];
    expect(projectSession(events)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning: "r1" },
      { role: "user", content: "q2" },
      { role: "tool", content: '{"status":"ok","result":{"ok":true}}', toolCallId: "c1" },
    ]);
  });

  it("确定性：同一事件流两次投影逐字段相等（E1 的重算口径）", () => {
    const events: SessionEvent[] = [
      se(1, "run-1", ev("run-1", 1, "TURN_INPUT", { role: "user", content: "x" })),
      se(1, "run-1", ev("run-1", 2, "MODEL_MESSAGE", { content: "y" })),
    ];
    expect(JSON.stringify(projectSession(events))).toBe(JSON.stringify(projectSession(events)));
  });

  it("空会话 = 空视图", () => {
    expect(projectSession([])).toEqual([]);
  });
});
