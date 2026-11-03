import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeelError } from "@keel/core";
import { Assembler, TOOL_CALL_TIMEOUT_MAX_MS, rangeContains } from "../src/assembler.js";

const SCHEMA_PATH = path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

/** 最小合法 capability manifest（越界能力带补偿模板）。 */
function capability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "capability",
    meta: { name: "plug-a", version: "1.2.0", title: "A", description: "test plugin" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
    ...overrides,
  };
}

function assemble(raw: unknown, contractVersion?: string, replacesVersion?: string) {
  const a = new Assembler({ schema, ...(contractVersion ? { contractVersion } : {}) });
  return a.assemble(raw, replacesVersion);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (err) {
    return err instanceof KeelError ? err.code : `other:${String(err)}`;
  }
}

describe("装配器：正路径", () => {
  it("capability manifest 装配成功，产出审计记录（第 5 步）", () => {
    const loaded = assemble(capability());
    expect(loaded.kind).toBe("capability");
    expect(loaded.templates).toEqual([]);
    expect(loaded.record).toEqual({
      manifest: { name: "plug-a", version: "1.2.0", kind: "capability" },
      permissions: [{ cap: "tool.provide" }],
      compensation: [],
    });
    expect(loaded.migration).toBeNull();
  });

  it("越界能力 + allow + 补偿模板 → 通过（第 2 步语义在位）", () => {
    const loaded = assemble(
      capability({
        permissions: [{ cap: "net.fetch", allow: ["api.example.com", "*.example.org"] }],
        compensation: {
          templates: [
            {
              kind: "webfetch.request-sent",
              class: "mitigable",
              action: { type: "plugin", ref: "compensations/cancelOrMark" },
              idempotency: "keyed",
            },
          ],
        },
      }),
    );
    expect(loaded.record.permissions).toEqual([
      { cap: "net.fetch", allow: ["api.example.com", "*.example.org"] },
    ]);
    expect(loaded.record.compensation).toEqual([
      { kind: "webfetch.request-sent", compensationClass: "mitigable", idempotency: "keyed" },
    ]);
  });

  it("热装配记录 replacesVersion（V5 审计）", () => {
    const loaded = assemble(capability(), undefined, "1.1.0");
    expect(loaded.record.replacesVersion).toBe("1.1.0");
  });

  it("record-only 极简模板（省略 action/idempotency）→ 归一为 builtin/record-only + natural", () => {
    const loaded = assemble(
      capability({
        permissions: [{ cap: "fs.write", allow: ["/tmp/**"] }],
        compensation: { templates: [{ kind: "fs.write.done", class: "record-only" }] },
      }),
    );
    expect(loaded.templates).toEqual([
      {
        kind: "fs.write.done",
        compensationClass: "record-only",
        action: { type: "builtin", ref: "record-only" },
        idempotency: "natural",
      },
    ]);
    expect(loaded.record.compensation).toEqual([
      { kind: "fs.write.done", compensationClass: "record-only", idempotency: "natural" },
    ]);
  });

  it("builtin fs.remove 模板 → 保留 type/ref（宿主内建派发，ADR-0016）", () => {
    const loaded = assemble(
      capability({
        permissions: [{ cap: "fs.write", allow: ["/tmp/**"] }],
        compensation: {
          templates: [
            {
              kind: "fs.write.done",
              class: "reversible",
              action: { type: "builtin", ref: "fs.remove" },
              idempotency: "natural",
            },
          ],
        },
      }),
    );
    expect(loaded.templates[0]).toMatchObject({
      action: { type: "builtin", ref: "fs.remove" },
    });
  });
});

describe("装配器：负路径（fail-closed）", () => {
  it("第 1 步：结构不过 Schema（缺 compat）→ 拒绝", () => {
    const raw = capability() as Record<string, unknown>;
    delete raw.compat;
    expect(codeOf(() => assemble(raw))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("第 2 步：net.fetch 缺 allow → 拒绝（语义层，Schema 不强制）", () => {
    expect(codeOf(() => assemble(capability({ permissions: [{ cap: "net.fetch" }] })))).toBe(
      "SCHED/MANIFEST-INVALID",
    );
  });

  it("第 2 步：越界能力零补偿模板 → 拒绝", () => {
    expect(
      codeOf(() =>
        assemble(
          capability({
            permissions: [{ cap: "fs.write", allow: ["/tmp/**"] }],
            compensation: { templates: [] },
          }),
        ),
      ),
    ).toBe("SCHED/MANIFEST-INVALID");
  });

  it("第 2 步：memory.backend 零补偿模板 → 拒绝", () => {
    expect(
      codeOf(() => assemble(capability({ permissions: [{ cap: "memory.backend" }] }))).valueOf(),
    ).toBe("SCHED/MANIFEST-INVALID");
  });

  it("第 3 步：toolCallTimeoutMs 超契约上限 → 拒绝（语义层复核）", () => {
    // Schema maximum 与契约一致，此处绕过 Schema 上限以验证语义层独立兜底
    const schemaNoMax = JSON.parse(JSON.stringify(schema));
    delete schemaNoMax.properties.resources.properties.toolCallTimeoutMs.maximum;
    const a = new Assembler({ schema: schemaNoMax });
    expect(() =>
      a.assemble(capability({ resources: { toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MAX_MS + 1 } })),
    ).toThrow(KeelError);
  });

  it("第 4 步：keelContract 范围不含当前契约版本 → 拒绝", () => {
    expect(codeOf(() => assemble(capability({ compat: { keelContract: "^2.0" } }), "1.0.0"))).toBe(
      "SCHED/MANIFEST-INVALID",
    );
    expect(codeOf(() => assemble(capability({ compat: { keelContract: "^1.0" } }), "1.0.0"))).toBe(
      "no-error",
    );
  });

  it("第 4 步：升级时 migration.from 不匹配已装版本 → 拒绝", () => {
    const raw = capability({
      migration: { from: "^2.0", steps: [{ to: "1.3.0", action: { type: "hook", ref: "m" } }] },
    });
    expect(codeOf(() => assemble(raw, "1.0.0", "1.2.0"))).toBe("SCHED/MANIFEST-INVALID");
    expect(codeOf(() => assemble(raw, "1.0.0", "2.1.0"))).toBe("no-error");
  });

  it("第 1 步：reversible 省略 action/idempotency → Schema 拒绝（只有 record-only 可省）", () => {
    const raw = capability({
      permissions: [{ cap: "fs.write", allow: ["/tmp/**"] }],
      compensation: { templates: [{ kind: "fs.write.done", class: "reversible" }] },
    });
    expect(codeOf(() => assemble(raw))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("第 2 步：未知 builtin ref → 拒绝（内建闭集，ADR-0016）", () => {
    const raw = capability({
      permissions: [{ cap: "fs.write", allow: ["/tmp/**"] }],
      compensation: {
        templates: [
          {
            kind: "fs.write.done",
            class: "reversible",
            action: { type: "builtin", ref: "fs.nuke" },
            idempotency: "natural",
          },
        ],
      },
    });
    expect(codeOf(() => assemble(raw))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("第 2 步：builtin record-only 配 reversible → 拒绝（内建引用与分级一致）", () => {
    const raw = capability({
      permissions: [{ cap: "fs.write", allow: ["/tmp/**"] }],
      compensation: {
        templates: [
          {
            kind: "fs.write.done",
            class: "reversible",
            action: { type: "builtin", ref: "record-only" },
            idempotency: "natural",
          },
        ],
      },
    });
    expect(codeOf(() => assemble(raw))).toBe("SCHED/MANIFEST-INVALID");
  });
});

describe("manifest 稿 §5.6（切片③ N1/N4 收口）", () => {
  it("N1：policy 带非空 templates → Schema 拒绝", () => {
    const policy = capability({
      kind: "policy",
      permissions: [],
      resources: {},
      hooks: ["stopAdvice"],
      compensation: {
        templates: [
          {
            kind: "x",
            class: "reversible",
            action: { type: "builtin", ref: "noop" },
            idempotency: "natural",
          },
        ],
      },
    });
    expect(codeOf(() => assemble(policy))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("N4：policy / observation 带 migration → Schema 拒绝", () => {
    const policy = capability({
      kind: "policy",
      permissions: [],
      resources: {},
      hooks: ["stopAdvice"],
      migration: { from: "^1.0", steps: [{ to: "1.3.0", action: { type: "hook", ref: "m" } }] },
    });
    const observation = capability({
      kind: "observation",
      permissions: [],
      resources: {},
      subscriptions: ["TOOL_RESULT"],
      migration: { from: "^1.0", steps: [{ to: "1.3.0", action: { type: "hook", ref: "m" } }] },
    });
    expect(codeOf(() => assemble(policy))).toBe("SCHED/MANIFEST-INVALID");
    expect(codeOf(() => assemble(observation))).toBe("SCHED/MANIFEST-INVALID");
  });
});

describe("manifest 负路径 fixtures 组（A5 语义，manifest 稿 §8）", () => {
  const NEG_DIR = path.resolve("fixtures/manifest-negative");
  const files = readdirSync(NEG_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  it("组内有预期的八枚负例（防目录漂移）", () => {
    expect(files).toEqual([
      "bad-meta-name.json",
      "boundary-no-template.json",
      "capability-with-hooks.json",
      "hook-unknown-name.json",
      "missing-net-allow.json",
      "policy-with-permissions.json",
      "policy-with-timeout.json",
      "unknown-top-field.json",
    ]);
  });

  it.each(files)("负例 %s 被装配器拒绝（SCHED/MANIFEST-INVALID）", (file) => {
    const raw = JSON.parse(readFileSync(path.join(NEG_DIR, file), "utf-8"));
    expect(codeOf(() => assemble(raw))).toBe("SCHED/MANIFEST-INVALID");
  });
});

describe("装配器：治理切面（ADR-0015）", () => {
  function governed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return capability({
      permissions: [{ cap: "fs.write", allow: ["/tmp/**"] }],
      compensation: {
        templates: [
          {
            kind: "fs.write.done",
            class: "reversible",
            action: { type: "builtin", ref: "fs.remove" },
            idempotency: "natural",
          },
        ],
      },
      governance: {
        tools: [
          {
            name: "write_file",
            guard: { cap: "fs.write", from: "path", prefix: "fs:" },
            effects: [
              { kind: "fs.write.done", targetFields: ["path"], digestFields: ["path", "content"] },
            ],
          },
        ],
      },
      ...overrides,
    });
  }

  it("合法 governance → LoadedManifest 保留声明（不进 ASSEMBLY_RECORDED）", () => {
    const loaded = assemble(governed());
    expect(loaded.governance).toEqual([
      {
        name: "write_file",
        guard: { cap: "fs.write", from: "path", prefix: "fs:" },
        effects: [
          { kind: "fs.write.done", targetFields: ["path"], digestFields: ["path", "content"] },
        ],
      },
    ]);
    expect(loaded.record).not.toHaveProperty("governance");
  });

  it("policy 带 governance → Schema 拒绝", () => {
    const raw = capability({
      kind: "policy",
      permissions: [],
      resources: {},
      hooks: ["stopAdvice"],
      governance: { tools: [{ name: "x" }] },
    });
    expect(codeOf(() => assemble(raw))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("effect kind 未命中补偿模板 → 拒绝", () => {
    const raw = governed();
    const gov = raw.governance as { tools: { effects: { kind: string }[] }[] };
    gov.tools[0].effects[0].kind = "fs.write.ghost";
    expect(codeOf(() => assemble(raw))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("guard.cap 未在 permissions 声明（或没有 allow）→ 拒绝", () => {
    const noDecl = governed({
      permissions: [{ cap: "tool.provide" }],
      compensation: { templates: [] },
    });
    expect(codeOf(() => assemble(noDecl))).toBe("SCHED/MANIFEST-INVALID");
    const noAllow = governed({ permissions: [{ cap: "fs.write" }] });
    expect(codeOf(() => assemble(noAllow))).toBe("SCHED/MANIFEST-INVALID");
  });

  it("重复工具名 / 空切面 / 重复字段 → 拒绝", () => {
    const dupName = governed();
    const dupGov = dupName.governance as { tools: unknown[] };
    dupGov.tools.push({ ...(dupGov.tools[0] as object) });
    expect(codeOf(() => assemble(dupName))).toBe("SCHED/MANIFEST-INVALID");

    const empty = governed({ governance: { tools: [{ name: "noop" }] } });
    expect(codeOf(() => assemble(empty))).toBe("SCHED/MANIFEST-INVALID");

    const dupField = governed();
    const fieldGov = dupField.governance as {
      tools: { effects: { targetFields: string[] }[] }[];
    };
    fieldGov.tools[0].effects[0].targetFields = ["path", "path"];
    expect(codeOf(() => assemble(dupField))).toBe("SCHED/MANIFEST-INVALID");
  });
});

describe("rangeContains（compat.keelContract 协商）", () => {
  it.each([
    ["^1.0", "1.0.0", true],
    ["^1.0", "1.9.9", true],
    ["^1.0", "2.0.0", false],
    ["~1.0", "1.0.5", true],
    ["~1.0", "1.1.0", false],
    [">=1.0", "3.0.0", true],
    [">=1.0", "0.9.0", false],
    ["1.0", "1.0.0", true],
    ["1.0", "1.0.1", false],
    ["^1.0", "bogus", false],
  ])("%s ∋ %s → %s", (range, version, want) => {
    expect(rangeContains(range, version)).toBe(want);
  });
});

describe("装配器：信任申请（ADR-0019）", () => {
  it("默认不授予：manifest 申请 rawIo → 装配拒绝", () => {
    expect(codeOf(() => assemble(capability({ trust: { rawIo: true } })))).toBe(
      "SCHED/MANIFEST-INVALID",
    );
  });

  it("宿主显式授予：trust=raw，并写入 ASSEMBLY_RECORDED.trust", () => {
    const loaded = new Assembler({ schema, allowRawIo: true }).assemble(
      capability({ trust: { rawIo: true } }),
    );
    expect(loaded.trust).toBe("raw");
    expect(loaded.record.trust).toBe("raw");
  });

  it("未申请 = mediated；旧载荷形状不变（record.trust 缺省）", () => {
    const loaded = assemble(capability());
    expect(loaded.trust).toBe("mediated");
    expect(loaded.record.trust).toBeUndefined();
  });
});
