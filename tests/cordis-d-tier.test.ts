/**
 * 集成测试（真实子进程）—— Phase 2 验收 **B4【一票否决】**：D 档两条（#7 自建预算/控制流、
 * #14 用策略插件绕控制面）在**装配期与运行期各有真实拒绝点**，且每组样本同时给出
 * "拒绝 + 留痕 + 零部分生效"（06 稿 §3.2 的七枚尝试与机械核对 (a)(b)(c)；01 稿 §5 第 3 条 D 档零例外）。
 *
 * 这条验收的失败形态不是"抛了个错"，而是**悄悄生效**：钩子装上了但没人记账、
 * 夹带的下一动作被执行了但账本里看不出来、畸形报关单"收了合法那几项"。
 * 所以每一行都按"拒绝之外还少了什么"来断言：事件计数 (a)、注入面源码扫描 (b)、整份拒绝无产物 (c)。
 *
 * 材料性质：合成样本（01 稿 §5 的证据表述纪律），不得表述为"真实存量插件已验证"。
 */
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeelError, type LedgerEvent } from "@keel/core";
import { Assembler } from "@keel/host";
import {
  createLegacyRig,
  fixtureFile,
  legacyManifest,
  policyFor,
  policySpec,
  repoRoot,
} from "./fixtures/cordis-rig";

const AGENT = "agent-b4";
const MANIFEST_PATH = path.join(
  repoRoot,
  "docs",
  "design",
  "phase-1",
  "schema",
  "keel-plugin.schema.json",
);
const NEG_DIR = path.join(repoRoot, "fixtures", "manifest-negative");
const manifestSchema: object = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

let sinkDir = "";
const open: { close(): Promise<void> }[] = [];

async function newSink(label: string): Promise<string> {
  const file = path.join(sinkDir, `${label}.sink`);
  await writeFile(file, "", "utf-8");
  return file;
}

function of(events: LedgerEvent[], type: string): LedgerEvent[] {
  return events.filter((e) => e.type === type);
}

function count(events: LedgerEvent[], type: string): number {
  return of(events, type).length;
}

function pl(e: LedgerEvent | undefined): Record<string, unknown> {
  return (e?.payload ?? {}) as Record<string, unknown>;
}

function invoked(events: LedgerEvent[], tool: string): number {
  return of(events, "TOOL_INVOKE").filter((e) => pl(e).tool === tool).length;
}

function resultFor(events: LedgerEvent[], tool: string): Record<string, unknown> {
  return pl(of(events, "TOOL_RESULT").find((e) => pl(e).tool === tool));
}

async function lines(file: string): Promise<string[]> {
  const text = await readFile(file, "utf-8");
  return text.trim() ? text.trim().split("\n") : [];
}

function readFace(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf-8");
}

beforeEach(async () => {
  sinkDir = await mkdtemp(path.join(tmpdir(), "keel-b4-"));
});

afterEach(async () => {
  await Promise.allSettled(open.map((r) => r.close()));
  open.length = 0;
  await rm(sinkDir, { recursive: true, force: true });
});

describe("B4 运行期拒绝（旧插件侧）", () => {
  it("#14：能力插件运行期装钩子 → ADAPTER/UNSUPPORTED 留痕，且此后一次插话都没有", async () => {
    const rig = createLegacyRig(); // 没绑策略：被拒的注册若"部分生效"，这里就会露出来
    open.push(rig);
    await rig.setup(policyFor(legacyManifest([{ cap: "tool.provide" }]), AGENT));
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-d14",
      runId: "run-d14",
      pluginPath: fixtureFile("tierD-14-self-hooks.cjs"),
      plan: [
        { visible: ["ok", "try.hook"], call: { tool: "try.hook" } },
        { call: { tool: "ok" } },
        { done: true },
      ],
    });
    expect((await probe.done).state).toBe("halted");
    expect(probe.violations).toEqual([]);

    const events = await rig.readRun("run-d14");
    const err = resultFor(events, "try.hook").error as Record<string, unknown>;
    expect(resultFor(events, "try.hook").status).toBe("error");
    expect(err.code).toBe("ADAPTER/UNSUPPORTED");
    // 拒绝之外还少了什么（核对 (a)）：钩子面没有被"半装上"——本 run 一条 HOOK_* 都没有
    expect(count(events, "HOOK_CALLED")).toBe(0);
    expect(count(events, "HOOK_VERDICT")).toBe(0);
    // 改法去处随拒绝一起给出（不是只说"不行"）：D 档的承接方式是手册里那四条白名单 hook
    expect(String(err.message)).toContain('kind:"policy"');
  });

  it("#7：工具返回值夹带下一动作 → 调度器不解读，被夹带的工具一次都没被执行", async () => {
    const rig = createLegacyRig();
    open.push(rig);
    await rig.setup(policyFor(legacyManifest([{ cap: "tool.provide" }]), AGENT));
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-d7a",
      runId: "run-d7a",
      pluginPath: fixtureFile("tierD-07-carry-next.cjs"),
      plan: [{ visible: ["chat", "echo"], call: { tool: "chat" } }, { done: true }],
    });
    expect((await probe.done).state).toBe("halted");

    const events = await rig.readRun("run-d7a");
    expect(invoked(events, "chat")).toBe(1);
    // 夹带的那一步没有发生：echo 只出现在可见表里，不在动作里
    expect(invoked(events, "echo")).toBe(0);
    expect(count(events, "TOOL_INVOKE")).toBe(1);
    expect(pl(of(events, "RUN_HALTED")[0]).reason).toBe("completed");
    // 夹带的字段确实进了账本（作为数据），但没有第二条动作（作为控制）——这才叫"不解读"
    expect(JSON.stringify(resultFor(events, "chat").resultDigest)).toContain("next");
  });

  it("#7：插件自建预算并自行宣布停止 → 终态不变，内核计量与插件自报数字无关", async () => {
    const rig = createLegacyRig();
    open.push(rig);
    await rig.setup(policyFor(legacyManifest([{ cap: "tool.provide" }]), AGENT));
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-d7b",
      runId: "run-d7b",
      pluginPath: fixtureFile("tierD-07-selfbudget-stop.cjs"),
      plan: [
        { visible: ["spend"], call: { tool: "spend" } },
        { call: { tool: "spend" } }, // 这一轮插件自己宣布 suggestStop / runStatus:"halted"
        { done: true },
      ],
    });
    const status = await probe.done;
    expect(status.state).toBe("halted");
    expect(status.reasonCode).toBeUndefined(); // 不是耗尽也不是失败——是 driver 自己收束的

    const events = await rig.readRun("run-d7b");
    expect(count(events, "RUN_FAILED")).toBe(0);
    expect(pl(of(events, "RUN_HALTED")[0]).reason).toBe("completed");
    // 预算的唯一事实源在内核：本 run 没有模型动作，内核计量就是 0，插件自报的 spent 不作数
    expect(rig.budget.query(probe.ref).run.used).toBe(0);
    expect(count(events, "BUDGET_RESERVED")).toBe(0);
  });
});

describe("B4 运行期拒绝（策略侧）", () => {
  it("策略裁决里夹带下一动作 → 整份作废走默认策略（连 deny 一起丢），工具照常执行", async () => {
    const rig = createLegacyRig({
      policies: [policySpec("carry-next-action.mjs", ["toolApproval"])],
    });
    open.push(rig);
    await rig.setup(policyFor(legacyManifest([{ cap: "tool.provide" }]), AGENT));
    const sink = await newSink("carry");
    const probe = rig.runLegacy({
      agentId: AGENT,
      sessionId: "sess-d7c",
      runId: "run-d7c",
      pluginPath: fixtureFile("attribution-tools.cjs"),
      plan: [
        { visible: ["mark", "transfer"], call: { tool: "mark", params: { sink } } },
        { done: true },
      ],
    });
    expect((await probe.done).state).toBe("halted");

    const events = await rig.readRun("run-d7c");
    const verdicts = of(events, "HOOK_VERDICT");
    expect(verdicts).toHaveLength(1);
    expect(pl(verdicts[0]).fallback).toBe(true);
    // 采纳的是默认策略，而不是"合法字段照用 + 额外字段忽略"
    expect(pl(verdicts[0]).verdict).toEqual({ verdict: "approve" });
    expect(invoked(events, "mark")).toBe(1);
    expect(await lines(sink)).toEqual(["mark"]);
  });

  it("策略舱没有执行面：向它要一次执行得到的是明确拒绝，而不是跑起来的东西", async () => {
    const rig = createLegacyRig({ policies: [policySpec("deny-transfer.mjs", ["toolApproval"])] });
    open.push(rig);
    await rig.setup(policyFor(legacyManifest([{ cap: "tool.provide" }]), AGENT));
    const cell = rig.policies[0].cell;
    // 契约 §3.3 那一行的字面（"四个 hook 被调用（被动），无主动接口"）在这里是可执行的：
    // 策略进程里没有工具表，向它要执行只会得到 TOOL-UNKNOWN
    const exec = await cell.conn.request("tool.exec", { tool: "mark", params: {} }, 2_000);
    expect(exec).toMatchObject({ status: "error", error: { code: "CELL/TOOL-UNKNOWN" } });
    const comp = await cell.conn
      .request("compensation.exec", { actionRef: "undo", targetSummary: "x" }, 2_000)
      .catch((e: unknown) => e);
    expect((comp as { code?: string }).code).toBe("CELL/ACTION-UNKNOWN");
  });
});

describe("B4 装配期拒绝（畸形报关单整份拒）", () => {
  const files = readdirSync(NEG_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  it("负例组逐枚都是 SCHED/MANIFEST-INVALID，且没有一份产出装配产物（核对 (c)）", () => {
    const assembler = new Assembler({ schema: manifestSchema });
    const results = files.map((f) => {
      const raw = JSON.parse(readFileSync(path.join(NEG_DIR, f), "utf-8"));
      try {
        return { file: f, record: assembler.assemble(raw).record, code: "" };
      } catch (err) {
        return { file: f, record: null, code: (err as KeelError).code };
      }
    });
    expect(results.map((r) => r.code)).toEqual(results.map(() => "SCHED/MANIFEST-INVALID"));
    // 整份拒绝 = 没有产物：不是"收下合法那几项"的部分接受
    expect(results.every((r) => r.record === null)).toBe(true);
    expect(files).toHaveLength(8);
  });

  it("切片④新增的两枚：能力插件持钩子面 / 策略插件自造时限（去掉越界项就能过）", () => {
    const assembler = new Assembler({ schema: manifestSchema });
    const capability = JSON.parse(
      readFileSync(path.join(NEG_DIR, "capability-with-hooks.json"), "utf-8"),
    );
    const policyTimeout = JSON.parse(
      readFileSync(path.join(NEG_DIR, "policy-with-timeout.json"), "utf-8"),
    );
    // 各自的"其余部分"单独拿出来都过——证明被拒的是那一处越界，不是整份材料的格式
    // （越界项要**删掉**而不是置空：hooks 的 minItems:1 与 capability 的 maxItems:0 是有意的互斥）
    const { hooks: dropped, ...capabilityRest } = capability;
    expect(dropped).toEqual(["toolApproval"]);
    expect(assembler.assemble(capabilityRest).kind).toBe("capability");
    expect(assembler.assemble({ ...policyTimeout, resources: {} }).kind).toBe("policy");
    expect(() => assembler.assemble(capability)).toThrowError(/schema validation/);
    expect(() => assembler.assemble(policyTimeout)).toThrowError(/schema validation/);
  });

  it("合不出来的报关单不会被顺手收下：装配失败即无 manifest 记录（也就没有 run 可起）", () => {
    const assembler = new Assembler({ schema: manifestSchema });
    const bad = {
      kind: "capability",
      meta: { name: "b4-bad", version: "1.0.0", title: "b", description: "d" },
      permissions: [{ cap: "tool.provide" }],
      resources: { toolCallTimeoutMs: 5_000 },
      compensation: { templates: [] },
      compat: { keelContract: "^1.0" },
      hooks: ["toolApproval"],
    };
    expect(() => assembler.assemble(bad)).toThrowError(KeelError);
    expect(() => assembler.assemble(bad)).toThrowError(/schema validation/);
  });
});

describe("B4 机械核对 (b)：内核命名空间不出现在插件可见那一份参数里", () => {
  /** 被扫的是注入面：承接层给旧插件的 ctx、策略入口给策略模块的载荷。 */
  const INJECT_FACES = [
    "packages/cordis-adapter/src/core.ts",
    "packages/cordis-adapter/src/cell-entry.ts",
    "packages/cell-runtime/src/policy-main.ts",
    "packages/cell-runtime/src/policy-hooks.ts",
  ];
  /** 这些符号一旦出现在注入面里，就意味着插件拿到了控制面的把手。 */
  const HANDLES = [
    "scheduler.",
    "new Scheduler",
    "ledger.append",
    "budget.configure",
    "run.start",
    "run.abort",
  ];

  it.each(INJECT_FACES)("%s 里没有控制面把手", (file) => {
    const text = readFace(file);
    expect(HANDLES.filter((h) => text.includes(h))).toEqual([]);
  });

  it("策略模块拿到的载荷只有 hook 入参：入口连内核包都不 import，更不递句柄", () => {
    const text = readFace("packages/cell-runtime/src/policy-main.ts");
    // bootstrap 的形状就是 {pluginPath, hooks}，多一个字段等于往策略进程里递东西
    expect(text).toContain("pluginPath: string;");
    expect(text).toContain("hooks: string[];");
    // 依赖闭包：只有 node:url 与本包两个模块——内核包不在图里（控制面不可达，不只是"没用到"）
    expect([...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual([
      "node:url",
      "./cell.js",
      "./policy-hooks.js",
    ]);
    // 递给策略模块的参数只有 mod + 声明集合这一个数组
    expect(text).toContain("normalizePolicyHooks(mod, boot.hooks)");
  });
});
