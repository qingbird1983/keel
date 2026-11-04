/**
 * Profile 装配面单元测试（Phase 4 切片②，01 稿 P1/P3/P4）：
 * 严格 YAML 子集解析器 + profile 结构校验 + 跨清单校验 + 装配器 R13 语义校验。
 * 真进程端到端见 tests/profile-assembly-e2e.test.ts。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeelError } from "@keel/core";
import { Assembler } from "../src/assembler.js";
import { loadProfile } from "../src/profile/assemble.js";
import { parseYamlSubset } from "../src/profile/parse.js";

const profileSchema = JSON.parse(
  readFileSync(path.resolve("docs/design/phase-4/schema/keel-profile.schema.json"), "utf-8"),
);
const manifestSchema = JSON.parse(
  readFileSync(path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json"), "utf-8"),
);
const assembler = new Assembler({ schema: manifestSchema });

let dir: string;
beforeAll(async () => {
  process.env.KEEL_TEST_MODEL_KEY = "sk-test-profile-fixture";
  dir = await mkdtemp(path.join(tmpdir(), "keel-profile-unit-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (err) {
    return err instanceof KeelError ? err.code : `other:${String(err)}`;
  }
}

function detailOf(fn: () => unknown): Record<string, unknown> | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { detail?: Record<string, unknown> }).detail;
  }
}

async function writeFixture(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(dir, "case-"));
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name);
    await writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
      "utf-8",
    );
  }
  return root;
}

function capability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "capability",
    meta: { name: "plug-a", version: "1.0.0", title: "A", description: "test plugin" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
    ...overrides,
  };
}

function engine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "engine",
    meta: { name: "engine-a", version: "1.0.0", title: "E", description: "test engine" },
    permissions: [{ cap: "model.adapter", reason: "loop" }],
    resources: {},
    compensation: { templates: [] },
    engine: {
      loop: "react",
      model: { ref: "model-a", name: "mock-chat" },
      tools: ["t1"],
      maxSteps: 8,
    },
    compat: { keelContract: "^1.0" },
    ...overrides,
  };
}

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "model",
    meta: { name: "model-a", version: "1.0.0", title: "M", description: "test model" },
    permissions: [],
    resources: {},
    compensation: { templates: [] },
    model: {
      provider: "mock",
      protocol: "mock",
      models: ["mock-chat"],
      auth: { ref: "KEEL_TEST_MODEL_KEY" },
      pricing: {
        "mock-chat": {
          unit: "usd_per_mtok",
          offPeak: { inputCached: 0.1, inputUncached: 0.2, output: 0.4 },
        },
      },
      timeouts: { idleMs: 30_000 },
    },
    compat: { keelContract: "^1.0" },
    ...overrides,
  };
}

describe("严格 YAML 子集解析器（P1）", () => {
  it("块映射 / 块序列 / 标量 / 注释 / 引号", () => {
    const text = [
      "# profile",
      "version: 1",
      'name: "local workspace" # inline',
      "scope:",
      "  agentId: local",
      "  sessionId: main",
      "plugins:",
      "  - id: a",
      "    kind: capability",
      "    enabled: true",
      "    ratio: 1.5",
      "    empty: null",
      "  - id: b",
      "    kind: model",
      "",
    ].join("\n");
    expect(parseYamlSubset(text)).toEqual({
      version: 1,
      name: "local workspace",
      scope: { agentId: "local", sessionId: "main" },
      plugins: [
        { id: "a", kind: "capability", enabled: true, ratio: 1.5, empty: null },
        { id: "b", kind: "model" },
      ],
    });
  });

  it("不支持构造 = 硬失败并给行号（不猜、不静默忽略）", () => {
    for (const text of [
      ["a: &anchor 1", 1],
      ["a: *alias", 1],
      ["a: [1, 2]", 1],
      ["a: {b: 1}", 1],
      ["a: |", 1],
      ["---", 1],
      ["a:\n\tb: 1", 2],
    ] as const) {
      const detail = detailOf(() => parseYamlSubset(text[0]));
      expect(codeOf(() => parseYamlSubset(text[0]))).toBe("SCHED/MANIFEST-INVALID");
      expect(detail?.line).toBe(text[1]);
    }
  });

  it("重复键拒绝（两张皮不静默覆盖）", () => {
    expect(codeOf(() => parseYamlSubset("a: 1\na: 2\n"))).toBe("SCHED/MANIFEST-INVALID");
  });
});

describe("profile 装载（P3/P4 前三步）", () => {
  async function profileOf(files: Record<string, unknown>, yaml: string): Promise<string> {
    const root = await writeFixture({ ...files, "profile.yaml": yaml });
    return path.join(root, "profile.yaml");
  }

  it("未知字段拒绝（additionalProperties:false）", async () => {
    const file = await profileOf(
      { "m.json": capability() },
      [
        "version: 1",
        "name: p",
        "extra: 1",
        "plugins:",
        "  - id: a",
        "    kind: capability",
        '    manifest: "./m.json"',
        '    module: "./m.json"',
        "",
      ].join("\n"),
    );
    expect(codeOf(() => loadProfile(file, { profileSchema, assembler }))).toBe(
      "SCHED/MANIFEST-INVALID",
    );
  });

  it("kind 交叉校验：profile 与 manifest 不一致即拒", async () => {
    const file = await profileOf(
      { "m.json": capability() },
      [
        "version: 1",
        "name: p",
        "plugins:",
        "  - id: a",
        "    kind: policy",
        '    manifest: "./m.json"',
        '    module: "./m.json"',
        "",
      ].join("\n"),
    );
    const detail = detailOf(() => loadProfile(file, { profileSchema, assembler }));
    expect(detail?.pluginId).toBe("a");
  });

  it("id 唯一", async () => {
    const file = await profileOf(
      { "m.json": capability() },
      [
        "version: 1",
        "name: p",
        "plugins:",
        "  - id: a",
        "    kind: capability",
        '    manifest: "./m.json"',
        '    module: "./m.json"',
        "  - id: a",
        "    kind: capability",
        '    manifest: "./m.json"',
        '    module: "./m.json"',
        "",
      ].join("\n"),
    );
    expect(codeOf(() => loadProfile(file, { profileSchema, assembler }))).toBe(
      "SCHED/MANIFEST-INVALID",
    );
  });
});

describe("装配器 R13：model / engine 语义校验", () => {
  it("engine 只允许 model.adapter（越界能力整份拒绝）", () => {
    const raw = engine({ permissions: [{ cap: "fs.read", allow: ["fs:/tmp/**"] }] });
    expect(codeOf(() => assembler.assemble(raw))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("engine.tools 重名拒绝；maxSteps 越界拒绝", () => {
    const dup = engine();
    (dup.engine as { tools: string[] }).tools = ["t1", "t1"];
    expect(codeOf(() => assembler.assemble(dup))).toBe("SCHED/MANIFEST-INVALID");
    const huge = engine();
    (huge.engine as { maxSteps: number }).maxSteps = 101;
    expect(codeOf(() => assembler.assemble(huge))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("model.auth.ref 只做 presence-only：缺失拒绝，错误只写 ref 名", () => {
    delete process.env.KEEL_TEST_MODEL_KEY;
    let caught: unknown;
    try {
      assembler.assemble(model());
    } catch (err) {
      caught = err;
    }
    expect((caught as KeelError).code).toBe("SCHED/MANIFEST-INVALID");
    const detail = (caught as KeelError).detail as Record<string, unknown>;
    expect(JSON.stringify(detail)).toContain("KEEL_TEST_MODEL_KEY");
    process.env.KEEL_TEST_MODEL_KEY = "sk-test-profile-fixture";
  });

  it("pricing 键集合必须等于 models；三桶非负有限；unit 只有 usd_per_mtok", () => {
    const mismatch = model();
    (mismatch.model as { pricing: Record<string, unknown> }).pricing = {
      other: {
        unit: "usd_per_mtok",
        offPeak: { inputCached: 0, inputUncached: 0, output: 0 },
      },
    };
    expect(codeOf(() => assembler.assemble(mismatch))).toBe("SCHED/MANIFEST-INVALID");

    const negative = model();
    const pricing = (negative.model as Record<string, unknown>).pricing as Record<
      string,
      { offPeak: Record<string, number> }
    >;
    pricing["mock-chat"]!.offPeak.output = -1;
    expect(codeOf(() => assembler.assemble(negative))).toBe("SCHED/MANIFEST-INVALID");

    const unit = model();
    const p2 = (unit.model as Record<string, unknown>).pricing as Record<string, unknown>;
    (p2["mock-chat"] as Record<string, unknown>).unit = "cny_per_mtok";
    expect(codeOf(() => assembler.assemble(unit))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("idleMs 不得超过总时限（300s 档）；peak 存在时 peakWindows 必填", () => {
    const idle = model();
    (idle.model as { timeouts: { idleMs: number } }).timeouts.idleMs = 300_001;
    expect(codeOf(() => assembler.assemble(idle))).toBe("SCHED/MANIFEST-INVALID");

    const peak = model();
    const pricing = (peak.model as Record<string, unknown>).pricing as Record<string, unknown>;
    (pricing["mock-chat"] as Record<string, unknown>).peak = {
      inputCached: 0.2,
      inputUncached: 0.4,
      output: 0.8,
    };
    expect(codeOf(() => assembler.assemble(peak))).toBe("SCHED/MANIFEST-INVALID");
  });
});
