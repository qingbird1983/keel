import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { FrameConn } from "@keel/cell-runtime";
import {
  Authorizer,
  Budgeter,
  ContextManager,
  EVENT_TYPES,
  Ledger,
  ModelGateway,
  type AuthPolicyInput,
  type LedgerEvent,
  type ModelUpstream,
  type RunRef,
  type Scope,
} from "@keel/core";
import { serveCellChannel, type CellChannelBinding } from "../src/cell-server.js";
import { EffectTracker } from "../src/effects.js";

let dir: string;
const ledgers: Ledger[] = [];
const scope: Scope = { agentId: "agent-1", sessionId: "sess-1" };
const ref: RunRef = { ...scope, runId: "run-1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-cs-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

const policy: AuthPolicyInput = {
  version: "p1",
  allow: [
    { subject: "cell-1", action: "model.invoke", resource: "model-x" },
    { subject: "cell-1", action: "tool.invoke", resource: "t-allowed" },
  ],
};

type TemplateMap = CellChannelBinding["templates"];

function rig(policyInput: AuthPolicyInput = policy, useTracker = false, templates?: TemplateMap) {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  const tracker = useTracker ? new EffectTracker({ ledger }) : undefined;
  const deps = {
    ledger,
    auth: new Authorizer(policyInput, ledger),
    budget: new Budgeter(ledger),
    ctx: new ContextManager(),
    gateway: new ModelGateway({
      ledger,
      auth: new Authorizer(policyInput, ledger),
      budget: new Budgeter(ledger),
      upstream: {
        invoke: vi.fn(async () => ({ result: { text: "hi" }, usage: { tokens: 3 }, cost: 1 })),
      } satisfies ModelUpstream,
    }),
    tracker,
  };
  const binding: CellChannelBinding = {
    scope,
    ref,
    subject: "cell-1",
    templates:
      templates ??
      new Map([
        [
          "webfetch.request-sent",
          {
            kind: "webfetch.request-sent",
            compensationClass: "mitigable",
            action: { type: "plugin", ref: "compensations/cancel" },
            idempotency: "keyed",
          },
        ],
      ]),
  };
  // 通道对：core 侧挂 serveCellChannel，测试扮演 Cell
  const coreIn = new PassThrough();
  const cellIn = new PassThrough();
  const coreConn = new FrameConn({ input: coreIn, output: cellIn });
  const cellConn = new FrameConn({ input: cellIn, output: coreIn });
  serveCellChannel(coreConn, binding, deps);
  const events: LedgerEvent[] = [];
  coreConn.onEvent((e) => void e); // 事件路由位（Core→Cell 推送 MVP 无推送方）
  const readAll = async () => {
    try {
      const page = await deps.ledger.read({ runId: ref.runId });
      events.push(...page.events);
    } catch (err) {
      // 账本尚无任何事件 = 未知 runId（契约 §4.4）；对负路径断言即空集
      if ((err as { code?: string }).code !== "LEDGER/CURSOR-INVALID") throw err;
    }
    return events;
  };
  return { deps, cellConn, readAll, tracker };
}

describe("cell-server：可见面（契约 §3.3 Cell 行）", () => {
  it("auth.check 允许/拒绝；拒绝留痕 AUTH_DENIED", async () => {
    const { cellConn, readAll } = rig();
    await expect(
      cellConn.request<{ allowed: boolean }>(
        "auth.check",
        { action: "tool.invoke", resource: "t-allowed" },
        500,
      ),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      cellConn.request<{ allowed: boolean; reason?: string }>(
        "auth.check",
        { action: "tool.invoke", resource: "t-denied" },
        500,
      ),
    ).resolves.toMatchObject({ allowed: false });
    const types = (await readAll()).map((e) => e.type);
    expect(types).toContain("AUTH_DENIED");
  });

  it("budget.query / tool.discover 以绑定作用域应答", async () => {
    const { deps, cellConn } = rig();
    deps.ctx.alloc(scope);
    deps.ctx.registerTool(scope, { name: "t", schemaVersion: 1, schema: {} });
    await expect(cellConn.request("budget.query", {}, 500)).resolves.toMatchObject({
      run: { used: 0 },
      session: { used: 0 },
    });
    await expect(cellConn.request("tool.discover", {}, 500)).resolves.toEqual([
      { name: "t", schemaVersion: 1, schema: {} },
    ]);
  });

  it("model.invoke 经网关（授权→预扣→代理→实结）", async () => {
    const { cellConn, readAll } = rig();
    const r = await cellConn.request<{ result: unknown }>(
      "model.invoke",
      { reqId: "rq-1", model: "model-x", params: { q: 1 }, estimate: 10 },
      2_000,
    );
    expect(r.result).toEqual({ text: "hi" });
    const types = (await readAll()).map((e) => e.type);
    expect(types).toContain("MODEL_INVOKED");
    expect(types).toContain("MODEL_USAGE");
    expect(types).toContain("BUDGET_SETTLED");
  });

  it("可见面之外的操作 → 拒绝（TRANSPORT/BADFRAME）", async () => {
    const { cellConn } = rig();
    await expect(
      cellConn.request("ledger.append", { type: "DECISION" }, 500),
    ).rejects.toMatchObject({
      code: "TRANSPORT/BADFRAME",
    });
  });
});

describe("cell-server：ledger.read 仅本 run（§3.3）", () => {
  it("Cell 携带他人 runId 的 filter 被强制覆盖", async () => {
    const { deps, cellConn } = rig();
    await deps.ledger.append(ref, "DECISION", { round: 1 });
    const page = await cellConn.request<{ events: { runId: string }[] }>(
      "ledger.read",
      { filter: { runId: "other-run", seqFrom: 0 } },
      500,
    );
    expect(page.events).toHaveLength(1);
    expect(page.events[0].runId).toBe("run-1"); // 强制为本通道绑定 run
  });
});

describe("cell-server：effect.declare（C-M1 焊点）", () => {
  it("已声明 effectKind → EFFECT_DECLARED 落账（载荷取自模板）", async () => {
    const { cellConn, readAll } = rig();
    const r = await cellConn.request<{ effectId: string; seq: number }>(
      "effect.declare",
      {
        effectId: "e-1",
        effectKind: "webfetch.request-sent",
        targetSummary: { url: "https://api.example.com/x" },
        compensation: {
          actionRef: "compensations/cancel",
          idempotency: "keyed",
          paramsDigest: { id: 1 },
        },
      },
      500,
    );
    expect(r.seq).toBeGreaterThan(0);
    const all = await readAll();
    const ev = all.find((e) => e.type === "EFFECT_DECLARED");
    expect(ev).toBeDefined();
    expect(ev?.payload).toMatchObject({
      effectId: "e-1",
      kind: "webfetch.request-sent",
      compensationClass: "mitigable",
      compensation: {
        actionRef: "compensations/cancel",
        actionType: "plugin",
        idempotency: "keyed",
      },
    });
  });

  it("builtin 模板 → EFFECT_DECLARED 携带 actionType=builtin（ADR-0016）", async () => {
    const templates: TemplateMap = new Map([
      [
        "fs.write.done",
        {
          kind: "fs.write.done",
          compensationClass: "reversible",
          action: { type: "builtin", ref: "fs.remove" },
          idempotency: "natural",
        },
      ],
    ]);
    const { cellConn, readAll } = rig(policy, false, templates);
    await cellConn.request(
      "effect.declare",
      {
        effectId: "e-b",
        effectKind: "fs.write.done",
        targetSummary: { path: "E:/tmp/x.txt" },
      },
      500,
    );
    const ev = (await readAll()).find((e) => e.type === "EFFECT_DECLARED");
    expect(ev?.payload).toMatchObject({
      effectId: "e-b",
      compensation: { actionRef: "fs.remove", actionType: "builtin" },
    });
  });

  it("未声明 effectKind → 拒绝且不留副作用（无 EFFECT_DECLARED）", async () => {
    const { cellConn, readAll } = rig();
    await expect(
      cellConn.request("effect.declare", { effectId: "e-2", effectKind: "fs.write.done" }, 500),
    ).rejects.toMatchObject({ code: "SCHED/MANIFEST-INVALID" });
    expect((await readAll()).map((e) => e.type)).not.toContain("EFFECT_DECLARED");
  });

  it("事件类型封闭集合含 EFFECT_DECLARED（账本写入合法）", () => {
    expect(EVENT_TYPES).toContain("EFFECT_DECLARED");
    expect(EVENT_TYPES).toContain("ASSEMBLY_RECORDED");
  });
});

describe("cell-server：声明期 dependsOn 校验 + 效果追踪（切片④）", () => {
  it("dependsOn 引用未知效果 → 拒绝且不留账（补偿稿 §5.2）", async () => {
    const { cellConn, readAll } = rig(policy, true);
    await expect(
      cellConn.request(
        "effect.declare",
        {
          effectId: "e-dep",
          effectKind: "webfetch.request-sent",
          dependsOn: ["ghost"],
          compensation: { actionRef: "compensations/cancel", idempotency: "keyed" },
        },
        500,
      ),
    ).rejects.toMatchObject({ code: "SCHED/MANIFEST-INVALID" });
    expect((await readAll()).map((e) => e.type)).not.toContain("EFFECT_DECLARED");
  });

  it("合法 dependsOn 链 → 落账且追踪器登记（未结集合）", async () => {
    const { cellConn, tracker, readAll } = rig(policy, true);
    await cellConn.request(
      "effect.declare",
      {
        effectId: "a",
        effectKind: "webfetch.request-sent",
        compensation: { actionRef: "c", idempotency: "natural" },
      },
      500,
    );
    await cellConn.request(
      "effect.declare",
      {
        effectId: "b",
        effectKind: "webfetch.request-sent",
        dependsOn: ["a"],
        compensation: { actionRef: "c", idempotency: "natural" },
      },
      500,
    );
    expect(tracker?.openCount(ref.runId)).toBe(2);
    expect((await readAll()).filter((e) => e.type === "EFFECT_DECLARED")).toHaveLength(2);
  });
});

describe("cell-server：运行期注册通道 tool.register / tool.remove（契约 §4.6，切片①·ADR-0010）", () => {
  /** 放行注册与撤名的策略（= permission-rules 由 tool.provide 编译出来的形状）。 */
  const regPolicy: AuthPolicyInput = {
    version: "p-reg",
    allow: [
      { subject: "cell-1", action: "tool.register", resource: "*" },
      { subject: "cell-1", action: "tool.remove", resource: "*" },
    ],
  };

  it("注册：版本由内核按现有条目指派（重复调用 = 覆盖且 +1），Cell 提交的版本号被忽略", async () => {
    const { deps, cellConn } = rig(regPolicy);
    deps.ctx.alloc(scope);
    await expect(
      cellConn.request("tool.register", { name: "alpha", schema: { v: 1 } }, 500),
    ).resolves.toEqual({ name: "alpha", schemaVersion: 1 });
    // 恶意/陈旧版本号都不作数：线上只认内核自己算出来的那一个
    await expect(
      cellConn.request(
        "tool.register",
        { name: "alpha", schemaVersion: 99, schema: { v: 2 } },
        500,
      ),
    ).resolves.toEqual({ name: "alpha", schemaVersion: 2 });
    expect(deps.ctx.discover(ref)).toEqual([{ name: "alpha", schemaVersion: 2, schema: { v: 2 } }]);
  });

  it("未声明能力（策略无规则）→ AUTH/DENIED，可见表一字未动且拒绝留痕", async () => {
    const { deps, cellConn, readAll } = rig(); // 默认 policy 不含 tool.register
    deps.ctx.alloc(scope);
    await expect(
      cellConn.request("tool.register", { name: "alpha", schema: {} }, 500),
    ).rejects.toMatchObject({ code: "AUTH/DENIED" });
    expect(deps.ctx.discover(ref)).toEqual([]);
    const denied = (await readAll()).find((e) => e.type === "AUTH_DENIED");
    expect(denied?.payload).toMatchObject({
      subject: "cell-1",
      action: "tool.register",
      resource: "alpha",
      policyVersion: "p1",
    });
  });

  it("作用域未分配 → CTX/SCOPE-UNKNOWN（适配器与通道都不擅自 alloc）", async () => {
    const { cellConn } = rig(regPolicy);
    await expect(
      cellConn.request("tool.register", { name: "alpha", schema: {} }, 500),
    ).rejects.toMatchObject({ code: "CTX/SCOPE-UNKNOWN" });
  });

  it("撤名：存在 → true 并传播下线（newSchemaVersion=0）；不存在 → false", async () => {
    const { deps, cellConn } = rig(regPolicy);
    deps.ctx.alloc(scope);
    await cellConn.request("tool.register", { name: "alpha", schema: {} }, 500);
    await expect(cellConn.request("tool.remove", { name: "alpha" }, 500)).resolves.toBe(true);
    expect(deps.ctx.discover(ref)).toEqual([]);
    await expect(cellConn.request("tool.remove", { name: "alpha" }, 500)).resolves.toBe(false);
    const changes = deps.ctx.consumeSchemaChanges(ref);
    expect(changes.map((c) => [c.tool, c.oldSchemaVersion, c.newSchemaVersion])).toEqual([
      ["alpha", 0, 1],
      ["alpha", 1, 0],
    ]);
    expect(changes.every((c) => c.affectedScope?.sessionId === scope.sessionId)).toBe(true);
  });

  it("注册只影响本 scope：他人分区结构上拿不到这个名字", async () => {
    const { deps, cellConn } = rig(regPolicy);
    const other: Scope = { agentId: "agent-2", sessionId: "sess-2" };
    deps.ctx.alloc(scope);
    deps.ctx.alloc(other);
    await cellConn.request("tool.register", { name: "alpha", schema: {} }, 500);
    expect(deps.ctx.discover({ ...other, runId: "run-2" })).toEqual([]);
  });

  it("缺 name / 非字符串 name → TRANSPORT/BADFRAME（帧语义误用，不进内核状态）", async () => {
    const { deps, cellConn } = rig(regPolicy);
    deps.ctx.alloc(scope);
    await expect(cellConn.request("tool.register", { schema: {} }, 500)).rejects.toMatchObject({
      code: "TRANSPORT/BADFRAME",
    });
    await expect(
      cellConn.request("tool.register", { name: 42, schema: {} }, 500),
    ).rejects.toMatchObject({ code: "TRANSPORT/BADFRAME" });
    expect(deps.ctx.discover(ref)).toEqual([]);
  });

  it("handler 不得跨通道写入（注册载荷里的 handler 字段被丢弃，仅 name+schema 进分区）", async () => {
    const { deps, cellConn } = rig(regPolicy);
    deps.ctx.alloc(scope);
    await cellConn.request(
      "tool.register",
      { name: "alpha", schema: { ok: true }, handler: "function(){...}" },
      500,
    );
    expect(deps.ctx.discover(ref)).toEqual([
      { name: "alpha", schemaVersion: 1, schema: { ok: true } },
    ]);
  });
});
