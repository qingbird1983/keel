/**
 * keel sessions —— 会话查看面（Phase 5 切片②，01 稿 §3.6 / 04 稿 C3/C4）。
 *
 * 只读：列表用会话读取面的 summary；show 默认打印模型视图（与引擎看到的一致），
 * `--raw` 打印原始事件流（含治理事件），`--json` 给机读。
 */

import {
  Ledger,
  SessionReader,
  projectSession,
  type SessionEvent,
  type SessionRef,
} from "@keel/core";

export interface SessionsOptions {
  action: "list" | "show";
  dataDir?: string;
  agent?: string;
  session?: string;
  raw?: boolean;
  json?: boolean;
}

export async function cmdSessions(opts: SessionsOptions): Promise<number> {
  if (!opts.dataDir) {
    console.error("sessions: --data-dir is required");
    return 2;
  }
  const ledger = new Ledger({ rootDir: opts.dataDir });
  const reader = new SessionReader(ledger);
  try {
    if (opts.action === "list") return await listSessions(ledger, reader, opts);
    if (!opts.session) {
      console.error("sessions show: --session is required");
      return 2;
    }
    return await showSession(ledger, reader, opts.session, opts);
  } finally {
    await ledger.close();
  }
}

async function listSessions(
  ledger: Ledger,
  reader: SessionReader,
  opts: SessionsOptions,
): Promise<number> {
  const agents = opts.agent ? [opts.agent] : await ledger.listAgents();
  const rows: string[][] = [];
  for (const agentId of agents) {
    for (const sessionId of await ledger.listSessions(agentId)) {
      const summary = await reader.summary({ agentId, sessionId });
      const last = summary.runs[summary.runs.length - 1];
      rows.push([
        agentId,
        sessionId,
        String(summary.runs.length),
        last?.runId ?? "-",
        last?.terminal ?? "-",
        summary.activeRunId ? "unfinished" : "ok",
        last?.startedAt ? new Date(last.startedAt).toISOString() : "-",
      ]);
    }
  }
  if (rows.length === 0) {
    console.info("no sessions");
    return 0;
  }
  if (opts.json) {
    console.info(JSON.stringify({ agents, sessions: rows }, null, 2));
    return 0;
  }
  const header = ["agent", "session", "runs", "last-run", "last-state", "state", "started"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : `  ${c.padEnd(widths[i])}`)).join("");
  console.info(line(header));
  for (const row of rows) console.info(line(row));
  return 0;
}

async function showSession(
  ledger: Ledger,
  reader: SessionReader,
  sessionId: string,
  opts: SessionsOptions,
): Promise<number> {
  const ref = await resolveRef(ledger, sessionId, opts.agent);
  const events = await readAll(reader, ref);
  const summary = await reader.summary(ref);
  if (opts.json) {
    console.info(
      JSON.stringify(
        {
          ref,
          runs: summary.runs,
          ...(opts.raw ? { events } : { messages: projectSession(events) }),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (opts.raw) {
    for (const se of events) {
      console.info(
        `${se.runOrdinal}.${se.event.seq} ${se.event.type} ${JSON.stringify(se.event.payload)}`,
      );
    }
    return 0;
  }
  const messages = projectSession(events);
  if (messages.length === 0) {
    console.info("(empty session)");
    return 0;
  }
  for (const m of messages) {
    const meta = [
      m.toolCallId !== undefined ? `id=${m.toolCallId}` : "",
      m.toolCalls !== undefined ? `toolCalls=${m.toolCalls.map((t) => t.name).join(",")}` : "",
    ]
      .filter((s) => s !== "")
      .join(" ");
    console.info(`${m.role}${meta !== "" ? ` (${meta})` : ""}: ${m.content}`);
  }
  return 0;
}

async function readAll(reader: SessionReader, ref: SessionRef): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await reader.read(ref, {}, cursor);
    out.push(...page.events);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

/** `--agent` 省略时：会话只在唯一 agent 下存在才自动定位；多个候选要求显式指定。 */
async function resolveRef(
  ledger: Ledger,
  sessionId: string,
  agent: string | undefined,
): Promise<SessionRef> {
  if (agent) {
    // 显式 agent 也要核对存在性：读不到 = 拒绝，不返回一个"看起来空"的会话（E4 零泄漏）
    if (!(await ledger.listSessions(agent)).includes(sessionId)) {
      throw new Error(`session "${sessionId}" not found under agent "${agent}"`);
    }
    return { agentId: agent, sessionId };
  }
  const matches: string[] = [];
  for (const agentId of await ledger.listAgents()) {
    if ((await ledger.listSessions(agentId)).includes(sessionId)) matches.push(agentId);
  }
  if (matches.length === 0) throw new Error(`session "${sessionId}" not found under the data dir`);
  if (matches.length > 1) {
    throw new Error(`session "${sessionId}" exists under multiple agents (${matches.join(", ")})`);
  }
  return { agentId: matches[0]!, sessionId };
}
