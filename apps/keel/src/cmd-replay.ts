/**
 * keel replay —— 从账本重放决策序列（A6 审计归因；04 稿 §2）。
 * 纯读 + 格式化，无重放执行语义（04 稿 §5 定案 4）；每类事件输出单行归因摘要。
 */
import { Ledger, type LedgerEvent } from "@keel/core";

export interface ReplayOptions {
  dataDir: string;
  run: string;
}

/** 单事件归因摘要（`seq TYPE detail`）。 */
export function formatEvent(e: LedgerEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const j = (v: unknown) => JSON.stringify(v);
  let detail: string;
  switch (e.type) {
    case "ASSEMBLY_RECORDED":
      detail = `manifest=${j(p.manifest)}`;
      break;
    case "RUN_STARTED":
    case "RUN_HALTED":
    case "RUN_FAILED":
    case "RUN_RECOVERED":
      detail = `${j(p)}`;
      break;
    case "ROUND_STARTED":
    case "ROUND_ENDED":
    case "CHECKPOINT":
      detail = `round=${String(p.round)}`;
      break;
    case "DECISION":
      detail = `round=${String(p.round)} summary=${j(p.summary)} basedOn=${j(p.basedOn)}`;
      break;
    case "AUTH_DENIED":
      detail = `subject=${String(p.subject)} ${String(p.action)} ${String(p.resource)} reason=${j(p.reason)}`;
      break;
    case "HOOK_CALLED":
    case "HOOK_VERDICT":
      detail = `hook=${String(p.hook)} round=${String(p.round)}${p.verdict !== undefined ? ` verdict=${j(p.verdict)}` : ""}${p.fallback ? " fallback=true" : ""}`;
      break;
    case "BUDGET_RESERVED":
      detail = `req=${String(p.reqId)} estimate=${String(p.estimate)} runLeft=${String(p.runRemaining)}`;
      break;
    case "BUDGET_SETTLED":
      detail = `res=${String(p.reservationId)} actual=${String(p.actual)} refund=${String(p.refund)}`;
      break;
    case "MODEL_INVOKED":
      detail = `model=${String(p.model)} req=${String(p.reqId)}`;
      break;
    case "MODEL_USAGE":
      detail = `req=${String(p.reqId)} usage=${j(p.usage)} cost=${String(p.cost)}`;
      break;
    case "TOOL_INVOKE":
      detail = `round=${String(p.round)} tool=${String(p.tool)} params=${j(p.paramsDigest)}`;
      break;
    case "TOOL_RESULT":
      detail = `round=${String(p.round)} tool=${String(p.tool)} status=${String(p.status)} ${String(p.durationMs)}ms${p.resultDigest !== undefined ? ` result=${j(p.resultDigest)}` : ""}${p.error !== undefined ? ` error=${j(p.error)}` : ""}`;
      break;
    case "TOOL_SCHEMA_CHANGED": {
      // V1 归因行：受影响 scope 显式可读（走 default 会被 100 字符截断丢 scope）
      const sc = p.affectedScope as { agentId?: string; sessionId?: string } | null;
      detail = `tool=${String(p.tool)} v=${String(p.oldSchemaVersion)}→${String(p.newSchemaVersion)} scope=${sc ? `${sc.agentId}/${sc.sessionId}` : "GLOBAL"}`;
      break;
    }
    case "EFFECT_DECLARED":
      detail = `effect=${String(p.effectId)} kind=${String(p.kind)} class=${String(p.compensationClass)} action=${j(p.compensation)}`;
      break;
    case "EFFECT_SETTLED":
      detail = `effect=${String(p.effectId)} outcome=${String(p.outcome)}`;
      break;
    case "COMPENSATION_EXECUTED":
      detail = `effect=${String(p.effectId)} attempt=${String(p.attempt)} digest=${j(p.resultDigest)} ${String(p.durationMs)}ms`;
      break;
    case "COMPENSATION_ESCALATED":
      detail = `effect=${String(p.effectId)} attempts=${String(p.attempts)} blockedResume=${String(p.blockedResume)} lastError=${j(p.lastError)}`;
      break;
    case "COMPENSATION_WAIVED":
      detail = `effect=${String(p.effectId)} by=${String(p.waivedBy)} reason=${j(p.reason)}`;
      break;
    case "STATE_SNAPSHOT_REF":
      detail = `ref=${String(p.ref)} v=${String(p.version)} round=${String(p.round)}`;
      break;
    default:
      detail = j(p).slice(0, 100);
  }
  return `${String(e.seq).padStart(4)} ${e.type.padEnd(22)} ${detail}`;
}

/** @returns 退出码：0 = 有事件可读；1 = run 无事件（不存在或为空）。 */
export async function cmdReplay(opts: ReplayOptions): Promise<number> {
  const ledger = new Ledger({ rootDir: opts.dataDir });
  try {
    const lines: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await ledger.read({ runId: opts.run }, cursor);
      for (const e of page.events) lines.push(formatEvent(e));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (lines.length === 0) {
      console.error(`replay: no events for run "${opts.run}" in ${opts.dataDir}`);
      return 1;
    }
    console.info(`# replay ${opts.run} — ${lines.length} events`);
    for (const line of lines) console.info(line);
    return 0;
  } finally {
    await ledger.close();
  }
}
