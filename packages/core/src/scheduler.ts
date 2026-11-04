/**
 * 调度器 —— 契约 §4.1：Run 生命周期 + 调度轮内部序列（不可插件化，V6 的结构性防御）。
 *
 * 轮序列（固定）：ROUND_STARTED → 读上下文（挂起 TOOL_SCHEMA_CHANGED 入账 + tool.discover）
 *   → 决策（DECISION，basedOn = 本 run 已写事件 seq）→ hook②（如注册）
 *   → 执行动作（工具/模型，经授权 + 预算 + hook①/hook③）→ CHECKPOINT → ROUND_ENDED。
 * - 调度器是账本唯一写入者（单写者，ADR-0004）；账本写失败 = fail-stop（RUN_FAILED）。
 * - 预算耗尽三档（§4.3）：hard-stop → 补偿收尾 + RUN_FAILED；graceful → 完成在途动作后停 +
 *   RUN_HALTED；policy → hook④ 在 {hardStop, graceful} 中选（fallback = hardStop）。
 * - hook③ 重试建议受 Core 钳制：≤3 次、退避 ≤30s（契约 §7）。
 * - 事件映射（切片②实现期细化，已注记契约 §4.1）：正常完成 = 末轮收束后写
 *   RUN_HALTED{reason:"completed"}；被拒动作（Core 授权或 hook① 否决）以
 *   TOOL_RESULT{status:"error", error.code:"AUTH/DENIED"} 统一落点。
 */

import { randomUUID } from "node:crypto";
import { KeelError } from "./errors.js";
import { Authorizer } from "./authorizer.js";
import { Budgeter } from "./budget.js";
import { ToolCatalog } from "./tool-catalog.js";
import { HookBus } from "./hooks.js";
import { ModelGateway } from "./gateway.js";
import {
  type DecisionPayload,
  type EventType,
  type LedgerEvent,
  type ToolSchemaChangedPayload,
} from "./events.js";
import { Ledger, type LedgerAppendOptions } from "./ledger.js";
import {
  MAX_BACKOFF_MS,
  MAX_RETRIES,
  type ActionOutcome,
  type CompensationScope,
  type DriverAction,
  type RunHandle,
  type RunManifest,
  type RunStatus,
  type SchedulerOptions,
} from "./scheduler-types.js";

export type {
  ActionOutcome,
  CompensationScope,
  DriverAction,
  DriverDecision,
  PendingCompensator,
  RoundContext,
  RunDriver,
  RunManifest,
  RunState,
  RunStatus,
  SchedulerOptions,
  ToolExecutor,
} from "./scheduler-types.js";

export class Scheduler {
  private readonly ledger: Ledger;
  private readonly auth: Authorizer;
  private readonly budget: Budgeter;
  private readonly ctx: ToolCatalog;
  private readonly hooks: HookBus;
  private readonly gateway: ModelGateway;
  private readonly maxRuns: number;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly onCheckpoint?: SchedulerOptions["onCheckpoint"];
  private readonly runs = new Map<string, RunHandle>();

  constructor(
    deps: {
      ledger: Ledger;
      auth: Authorizer;
      budget: Budgeter;
      ctx: ToolCatalog;
      hooks: HookBus;
      gateway: ModelGateway;
    },
    opts: SchedulerOptions = {},
  ) {
    this.ledger = deps.ledger;
    this.auth = deps.auth;
    this.budget = deps.budget;
    this.ctx = deps.ctx;
    this.hooks = deps.hooks;
    this.gateway = deps.gateway;
    this.maxRuns = opts.maxConcurrentRuns ?? 256;
    this.now = opts.now ?? (() => Date.now());
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onCheckpoint = opts.onCheckpoint;
  }

  /** run.start：校验 manifest → 创建 Run → 首轮调度随即开始；同 runId 幂等返回既有结果。 */
  start(manifest: RunManifest): { runId: string; done: Promise<RunStatus> } {
    this.validate(manifest);
    const existing = this.runs.get(manifest.ref.runId);
    if (existing) return { runId: existing.ref.runId, done: existing.done };
    if (this.runs.size >= this.maxRuns) {
      throw new KeelError("SCHED/BACKPRESSURE", "concurrent run limit reached", {
        maxConcurrentRuns: this.maxRuns,
      });
    }
    // 手动 deferred（tsconfig.base 锁 ES2022，无 Promise.withResolvers）
    let settle!: (s: RunStatus) => void;
    const done = new Promise<RunStatus>((r) => (settle = r));
    const h: RunHandle = {
      manifest,
      ref: manifest.ref,
      round: 0,
      state: "running",
      lastCheckpoint: null,
      events: [],
      history: [],
      cancelRequested: false,
      done,
      settle,
    };
    this.runs.set(h.ref.runId, h);
    void this.loop(h);
    return { runId: h.ref.runId, done };
  }

  /** run.cancel：停止派发新轮；在途轮正常收束后写 RUN_HALTED。 */
  async cancel(runId: string): Promise<RunStatus> {
    const h = this.mustGet(runId);
    if (h.state === "running") {
      h.state = "halting";
      h.cancelRequested = true;
    }
    return h.done;
  }

  /**
   * abort 缝（契约 §4.1 注记④，ADR-0005）：Cell 进程退出三分类的统一落点——
   * 停止派发新轮，在途轮正常收束（CHECKPOINT/ROUND_ENDED）后写 RUN_FAILED{reasonCode}。
   * 与 cancel 对偶：cancel → RUN_HALTED，abort → RUN_FAILED。已终态则幂等 no-op。
   */
  abort(runId: string, reasonCode: string, message?: string): Promise<RunStatus> {
    const h = this.mustGet(runId);
    if (h.state === "running") {
      h.state = "halting";
      h.cancelRequested = true;
      h.abortCode = reasonCode;
      h.abortMessage = message;
    }
    return h.done;
  }

  /** run.status：状态机位置 + 最近一致点。 */
  status(runId: string): RunStatus {
    return this.snapshot(this.mustGet(runId));
  }

  /* ── 内部：轮循环 ─────────────────────────────────────────────────── */

  private async loop(h: RunHandle): Promise<void> {
    try {
      // 装配审计基线（切片③）：run 首事件（seq 1）。
      // Phase 4 切片②：profile 装配逐插件写，按声明序作为 run 的**首批**事件（01 稿 P6）。
      const records =
        h.manifest.assembly === undefined
          ? []
          : Array.isArray(h.manifest.assembly)
            ? h.manifest.assembly
            : [h.manifest.assembly];
      for (const record of records) await this.emit(h, "ASSEMBLY_RECORDED", record);
      // 恢复延续（契约 §4.1 注记⑦）：RUN_RECOVERED 先于 RUN_STARTED
      if (h.manifest.recoveredFrom) {
        await this.emit(h, "RUN_RECOVERED", {
          newRunId: h.ref.runId,
          recoveredFromSeq: h.manifest.recoveredFrom.seq,
        });
      }
      await this.emit(h, "RUN_STARTED", {
        ...(h.manifest.sessionRun !== undefined ? { sessionRun: h.manifest.sessionRun } : {}),
      });
      // 首轮前的缝（Phase 5 R8）：压缩标记与其摘要调用都在这里落本 run，且在本次输入之前。
      if (h.manifest.beforeFirstRound) {
        await h.manifest.beforeFirstRound({ ref: h.ref, ledger: this.ledger });
      }
      // run 起始输入（Phase 4 切片④）：表面事件族的第一条，先于首轮。
      if (h.manifest.turnInput) await this.emit(h, "TURN_INPUT", h.manifest.turnInput);
      for (;;) {
        if (h.cancelRequested) {
          if (h.abortCode !== undefined) await this.failRun(h, h.abortCode, h.abortMessage);
          else await this.haltCancelled(h);
          break;
        }
        h.round += 1;
        if ((await this.round(h)) === "continue") continue;
        break; // 终态已在 round 内落账
      }
    } catch (err) {
      // reasonCode 是载荷级字符串：驱动方可以带契约外的原因码（ENGINE_PROTOCOL /
      // ENGINE_EXITED / MAX_STEPS 等，R8），但错误对象仍必须是"带 code 的结构化错误"。
      const code =
        err instanceof KeelError
          ? err.code
          : typeof (err as { code?: unknown })?.code === "string"
            ? (err as { code: string }).code
            : "DRIVER-ERROR";
      await this.failRun(h, code, err instanceof Error ? err.message : String(err));
    }
    h.settle(this.snapshot(h));
  }

  private async round(h: RunHandle): Promise<"continue" | "stop"> {
    const { ref } = h;
    await this.emit(h, "ROUND_STARTED", { round: h.round });

    // 读上下文：本 scope 挂起 schema 变更入账（仅传播到受影响 scope，V1）+ 工具表
    for (const ch of this.ctx.consumeSchemaChanges(ref)) {
      await this.emit(h, "TOOL_SCHEMA_CHANGED", ch satisfies ToolSchemaChangedPayload);
    }
    const tools = this.ctx.discover(ref);

    // 决策（不可插件化；basedOn = 本决策显式引用的关键事件，依据上界由账本盖章 = ADR-0008）
    const decision = await h.manifest.driver.decide({
      run: ref,
      round: h.round,
      tools,
      history: h.history,
      events: [...h.events],
    });
    // throughSeq 由**账本在写入点**盖章（stampSeqBeforeAs）：这里 h.events 只有调度器自己写的 seq，
    // 授权/预算/网关/效果/快照那几路直写事件不在其中——"决策看得见什么"的答案是上界，不是列举。
    // basedOn = 调度器已写事件 ∪ 决策方显式引用（engine 的模型事件是直写，不在 h.events）；
    // 排序去重后交给账本盖 throughSeq（上界仍由账本在执行期盖章）。
    const basedOn = [...new Set([...h.events, ...(decision.basedOn ?? [])])].sort((a, b) => a - b);
    await this.emit(
      h,
      "DECISION",
      {
        round: h.round,
        summary: decision.summary,
        basedOn,
      } satisfies DecisionPayload,
      { stampSeqBeforeAs: "throughSeq" },
    );

    // hook②（每轮决策后；采纳与否由 Core 裁决，MVP 采纳建议）
    let stopAdvised = false;
    if (this.hooks.registered("stopAdvice")) {
      const res = await this.hooks.call(ref, "stopAdvice", h.round, {
        round: h.round,
        summary: decision.summary,
      });
      h.events.push(...res.seqs);
      stopAdvised = res.verdict.suggestStop;
    }

    // 执行（工具/模型，经授权 + 预算）
    const outcomes: ActionOutcome[] = [];
    let exhausted: "graceful" | "hard-stop" | null = null;
    for (const action of decision.done ? [] : (decision.actions ?? [])) {
      try {
        outcomes.push(await this.execAction(h, action));
      } catch (err) {
        if (err instanceof KeelError && err.code === "BUDGET/EXHAUSTED") {
          exhausted = await this.resolveExhaustion(h, err);
          break; // 停止接受新副作用；在途动作已完成
        }
        throw err; // 未预期内部错误 → fail-stop
      }
    }
    h.history = outcomes;

    // 补偿收尾（耗尽中断路径，T4 verify：只核验未决不回滚）；升级阻断 → RECOVER/COMPENSATION-FAILED
    if (exhausted && !(await this.compensate(h, "verify"))) {
      await this.failRun(h, "RECOVER/COMPENSATION-FAILED", "wrap-up compensation failed");
      return "stop";
    }

    // 轮收束：CHECKPOINT → STATE_SNAPSHOT_REF 缝 → ROUND_ENDED（契约 §5 + I3 顺序硬约束）
    // CHECKPOINT 必经 ledger.checkpoint（flush+fsync + lastCheckpoint 恢复锚，契约 §4.4）
    const cp = await this.ledger.checkpoint(h.ref, h.round);
    h.events.push(cp.seq);
    h.lastCheckpoint = { seq: cp.seq, round: h.round };
    if (this.onCheckpoint) {
      try {
        await this.onCheckpoint(h.ref, { seq: cp.seq, round: h.round });
      } catch {
        /* 快照为辅助元数据（D3）：宿主失败按尽力处理，一致性锚 CHECKPOINT 已落 */
      }
    }
    await this.emit(h, "ROUND_ENDED", { round: h.round });

    // abort/cancel 于在途轮到达：一致点已落，终态交 loop 顶部收束（契约 §4.1 注记④收束序）
    if (h.cancelRequested) return "continue";
    if (exhausted === "graceful") {
      await this.emit(h, "RUN_HALTED", { reasonCode: "BUDGET/EXHAUSTED-GRACEFUL" });
      h.state = "halted";
      h.reasonCode = "BUDGET/EXHAUSTED-GRACEFUL";
      return "stop";
    }
    if (exhausted === "hard-stop") {
      await this.emit(h, "RUN_FAILED", { reasonCode: "BUDGET/EXHAUSTED" });
      h.state = "failed";
      h.reasonCode = "BUDGET/EXHAUSTED";
      return "stop";
    }
    if (decision.done || stopAdvised) {
      // 结构性上限（如 MAX_STEPS）走 reasonCode；正常完成仍是 reason（旧账本形状不变）。
      if (decision.done && decision.haltReason !== undefined) {
        await this.emit(h, "RUN_HALTED", { reasonCode: decision.haltReason });
        h.state = "halted";
        h.reasonCode = decision.haltReason;
      } else {
        await this.emit(h, "RUN_HALTED", {
          reason: decision.done ? "completed" : "stop-advised",
        });
        h.state = "halted";
      }
      return "stop";
    }
    return "continue";
  }

  /* ── 内部：动作执行 ───────────────────────────────────────────────── */

  private async execAction(
    h: RunHandle,
    action: DriverAction,
    attempt = 0,
  ): Promise<ActionOutcome> {
    const { ref, manifest } = h;
    if (action.kind === "model") {
      try {
        const r = await this.gateway.invoke(ref, manifest.subject, {
          reqId: action.reqId,
          model: action.model,
          params: action.params,
          estimate: action.estimate,
        });
        return { action, ok: true, resultDigest: r.result };
      } catch (err) {
        if (err instanceof KeelError && err.code === "GATEWAY/UPSTREAM-ERROR") {
          const advice = await this.hooks.call(ref, "retryAdvice", h.round, {
            model: action.model,
            attempt,
            error: err.detail,
          });
          h.events.push(...advice.seqs);
          // 同 reqId 重试：预扣幂等（不重复计费），上游失败不缓存
          if (advice.verdict.policy === "retry" && attempt < MAX_RETRIES) {
            await this.delay(Math.min(advice.verdict.backoffMs ?? 0, MAX_BACKOFF_MS));
            return this.execAction(h, action, attempt + 1);
          }
          return { action, ok: false, error: { code: err.code } };
        }
        if (err instanceof KeelError && err.code === "AUTH/DENIED") {
          return { action, ok: false, error: { code: "AUTH/DENIED" } }; // 不可重试
        }
        throw err; // BUDGET/EXHAUSTED 或未预期 → 调度轮处置
      }
    }

    // 工具：Core 授权 → hook① 否决权 → 执行（hook③ 重试钳制 ≤3 次）
    // toolCallId 优先用决策方给的（engine 的模型 tool_call id）；缺省 Core 生成，
    // 带本 run 前缀（Phase 5 R9）：跨 run 投影时两个 run 的随机 id 撞号会配错结果。
    const toolCallId = action.toolCallId ?? `${ref.runId}-${randomUUID()}`;
    const d = await this.auth.check(ref, manifest.subject, "tool.invoke", action.tool);
    if (!d.allowed) return this.deniedTool(h, action, "core", d.reason);
    const approval = await this.hooks.call(ref, "toolApproval", h.round, {
      tool: action.tool,
      paramsDigest: action.params,
    });
    h.events.push(...approval.seqs);
    if (approval.verdict.verdict === "deny") {
      return this.deniedTool(h, action, "policy-hook", approval.verdict.reason);
    }
    for (let attempt = 0; ; attempt++) {
      const t0 = this.now();
      await this.emit(h, "TOOL_INVOKE", {
        round: h.round,
        tool: action.tool,
        paramsDigest: action.params,
      });
      const res = await h.manifest.executor({
        tool: action.tool,
        params: action.params,
        toolCallId,
      });
      await this.emit(h, "TOOL_RESULT", {
        round: h.round,
        tool: action.tool,
        status: res.status,
        durationMs: this.now() - t0,
        resultDigest: res.status === "ok" ? res.result : undefined,
        error: res.status === "ok" ? undefined : res.error,
        // 表面投影的关联键（E4）：模型消息里的 toolCalls[].id 与这里必须能对上。
        toolCallId,
      });
      if (res.status === "ok") return { action, ok: true, resultDigest: res.result };
      const advice = await this.hooks.call(ref, "retryAdvice", h.round, {
        tool: action.tool,
        attempt,
        error: res.error,
      });
      h.events.push(...advice.seqs);
      if (advice.verdict.policy === "retry" && attempt < MAX_RETRIES) {
        await this.delay(Math.min(advice.verdict.backoffMs ?? 0, MAX_BACKOFF_MS));
        continue;
      }
      return { action, ok: false, error: res.error ?? { code: "TOOL-FAILED" } };
    }
  }

  /** 被拒动作统一落点（切片②注记：TOOL_RESULT error + AUTH/DENIED，归因 by 字段）。 */
  private async deniedTool(
    h: RunHandle,
    action: Extract<DriverAction, { kind: "tool" }>,
    by: "core" | "policy-hook",
    reason?: string,
  ): Promise<ActionOutcome> {
    await this.emit(h, "TOOL_RESULT", {
      round: h.round,
      tool: action.tool,
      status: "error",
      durationMs: 0,
      error: { code: "AUTH/DENIED", by, reason },
      ...(action.toolCallId !== undefined ? { toolCallId: action.toolCallId } : {}),
    });
    return { action, ok: false, error: { code: "AUTH/DENIED", by } };
  }

  /** 预算耗尽处置：policy 档交 hook④ 在 Core 给定选项中选（fallback = hardStop）。 */
  private async resolveExhaustion(h: RunHandle, err: KeelError): Promise<"graceful" | "hard-stop"> {
    const detail = (err.detail ?? {}) as { mode?: string; level?: string };
    if (detail.mode === "graceful") return "graceful";
    if (detail.mode !== "policy") return "hard-stop";
    const res = await this.hooks.call(h.ref, "budgetExhaustedChoice", h.round, {
      level: detail.level,
      budget: this.budget.query(h.ref),
    });
    h.events.push(...res.seqs);
    return res.verdict.action === "graceful" ? "graceful" : "hard-stop";
  }

  /* ── 内部：终态收束 ───────────────────────────────────────────────── */

  /** 补偿收尾缝：true = 完成；false = 升级阻断（调用方落 RECOVER/COMPENSATION-FAILED）。 */
  private async compensate(h: RunHandle, mode: CompensationScope): Promise<boolean> {
    if (!h.manifest.compensator) return true;
    try {
      return await h.manifest.compensator(mode);
    } catch {
      return false;
    }
  }

  private async haltCancelled(h: RunHandle): Promise<void> {
    if (!(await this.compensate(h, "run"))) {
      await this.failRun(h, "RECOVER/COMPENSATION-FAILED", "wrap-up compensation failed");
      return;
    }
    await this.emit(h, "RUN_HALTED", { reason: "cancelled" });
    h.state = "halted";
  }

  /** fail-stop：补偿（T3 全 Run，尽力）→ 一致点与轮收束（尽力）→ RUN_FAILED。 */
  private async failRun(h: RunHandle, code: string, message?: string): Promise<void> {
    if (h.state === "failed") return;
    await this.compensate(h, "run"); // 尽力收尾；其自身失败不再级联
    try {
      const cp = await this.ledger.checkpoint(h.ref, h.round);
      h.events.push(cp.seq);
      h.lastCheckpoint = { seq: cp.seq, round: h.round };
      await this.emit(h, "ROUND_ENDED", { round: h.round });
    } catch {
      /* 账本已 fail-stop：放弃落盘 */
    }
    try {
      await this.emit(h, "RUN_FAILED", { reasonCode: code, reason: message });
    } catch {
      /* 同上 */
    }
    h.state = "failed";
    h.reasonCode = code;
  }

  private async emit(
    h: RunHandle,
    type: EventType,
    payload: unknown,
    opts?: LedgerAppendOptions,
  ): Promise<LedgerEvent> {
    const ev = await this.ledger.append(h.ref, type, payload, opts);
    h.events.push(ev.seq);
    return ev;
  }

  private mustGet(runId: string): RunHandle {
    const h = this.runs.get(runId);
    if (!h) throw new KeelError("SCHED/NOT-FOUND", "unknown runId", { runId });
    return h;
  }

  private snapshot(h: RunHandle): RunStatus {
    return {
      state: h.state,
      rounds: h.round,
      lastCheckpoint: h.lastCheckpoint,
      ...(h.reasonCode !== undefined ? { reasonCode: h.reasonCode } : {}),
    };
  }

  private validate(m: RunManifest): void {
    const ref = m?.ref;
    const ok =
      !!ref &&
      nonEmpty(ref.agentId) &&
      nonEmpty(ref.sessionId) &&
      nonEmpty(ref.runId) &&
      nonEmpty(m.subject) &&
      typeof m.executor === "function" &&
      typeof m.driver?.decide === "function";
    if (!ok) {
      throw new KeelError("SCHED/MANIFEST-INVALID", "run manifest failed minimal validation", {
        ref: m?.ref,
      });
    }
  }
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}
