/**
 * Phase 3 切片①（design/phase-3/02 稿 §3）：原生插件禁面扫描的门禁测试。
 *
 * 两组断言（P-012 的教训：自我宣判要拆问，"扫描器存在"不等于"扫描器有效"）：
 * 1. 负样本组：对符号表每一条判据生成含毒样本（临时目录，不入库），扫描器必须逐条
 *    命中对应 01 清单行号——证明扫描器本身有效；
 * 2. 实扫组：对 `packages/plugins/**` 实扫零命中——证明在库原生插件干净。
 *
 * 禁面符号表唯一来源：docs/design/phase-3/01-legacy-anti-patterns.md（只增不改）；
 * 机械判据定义在 scripts/scan-native-plugins.mjs（本测试红先于该文件存在）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_SURFACES,
  REQUIRED_ROWS,
  REQUIRED_RULE_IDS,
  scanNativePlugins,
} from "../scripts/scan-native-plugins.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = path.join(REPO_ROOT, "packages", "plugins");

/** 每条机械判据一个含毒样本（02 稿 §2 的判据 ↔ 01 清单行的对应由 REQUIRED_ROWS 钉住） */
const POISON_SNIPPETS: Record<string, string> = {
  A1: "const s = systemPrompt.section('extra');\n",
  A2: "export function done(exec) { exec.concludeTurn(); }\n",
  A3: "const remainingBudget = 100; // self-computed\n",
  A4: "export function after(exec) { exec.deferContext('next'); }\n",
  B1: "await approvalSvc.request('danger');\nconst p = { sandbox_permissions: 'full' };\n",
  B2: "const sid = sessionId;\nconst a = exec.agent;\n",
  B3: "const shell = ctx.get('shell');\n",
  B5: "const tool = { timeoutMs: 5000, isConcurrencySafe: true };\n",
  C1: "ctx.provide('id', impl);\nconst deps = ctx.inject(['id']);\n",
  C2: "ctx.bus.emit('ev', 1);\nbus.on('ev', () => {});\n",
  C3: "ctx.share.set('k', 1);\nctx.state.count = 2;\n",
  C4: "const cfg = load('cordis.patch.yml');\nconst name = 'dsh.demo';\n",
  D1: "export function activate(ctx) {}\nexport default { apply(ctx, config) {} };\n",
  D3: "const where = { dsh: { client: { platform: 'web' } } };\n",
  "B4-import": "import leftPad from 'left-pad';\nimport { thing } from '@deepseek-ai/cordis';\n",
  // Phase 4 K6（04 稿 §4）
  "E1-net":
    'import { request } from "node:https";\nconst r = await fetch("https://example.com");\n',
  "E2-env": "const key = process.env.DEEPSEEK_API_KEY;\n",
  "E3-ledger": 'await ledger.append(ref, "X", {});\neffect.declare({ kind: "fs" });\n',
  "E4-hook": 'await policy.hook("toolApproval", input);\nhooks.register("stopAdvice", fn);\n',
  "E5-key": 'const leaked = "sk-live-1234567890";\n',
  "M1-cost": "export function invoke() { return { result: {}, usage: {}, cost: 3 }; }\n",
};

async function writePlugin(root: string, rel: string, body: string): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
}

describe("native plugin forbidden-surface scan", () => {
  it("符号表覆盖 01 清单的全部机械判据行（防漏报的完备性断言）", () => {
    const covered = new Set(FORBIDDEN_SURFACES.map((r) => r.row));
    for (const row of REQUIRED_ROWS) {
      expect(covered.has(row), `01 清单行 ${row} 没有对应的机械判据`).toBe(true);
    }
  });

  it("Phase 4 判据齐全（K6：04 稿 §4 的六条按 kind 规则）", () => {
    const ids = new Set(FORBIDDEN_SURFACES.map((r) => r.id));
    for (const id of REQUIRED_RULE_IDS) {
      expect(ids.has(id), `Phase 4 判据 ${id} 缺失`).toBe(true);
    }
  });

  it(
    "负样本组：每条判据的含毒样本都被命中对应 01 行号",
    // 16 条判据逐条 mkdtemp+扫描+清理，Windows 文件系统上贴近默认 5s 上限（P-006 同款时序敏感）
    { timeout: 30_000 },
    async () => {
      for (const rule of FORBIDDEN_SURFACES) {
        const dir = await mkdtemp(path.join(tmpdir(), "keel-scan-negative-"));
        try {
          if (rule.id === "B4-deps") {
            await writePlugin(
              dir,
              "pkg/package.json",
              JSON.stringify({ name: "poison", dependencies: { "left-pad": "^1.0.0" } }),
            );
          } else {
            const snippet = POISON_SNIPPETS[rule.id];
            expect(snippet, `判据 ${rule.id} 缺少负样本`).toBeTruthy();
            // 按 kind 生效的判据：先给它一份带 kind 的清单，否则规则不适用（这正是被测语义）
            const kind = rule.kinds?.[0];
            if (kind) {
              await writePlugin(
                dir,
                "pkg/keel-plugin.json",
                JSON.stringify({ kind, meta: { name: "poison" } }),
              );
            }
            await writePlugin(dir, "pkg/entry.ts", snippet);
          }
          const hits = await scanNativePlugins(dir);
          expect(
            hits.map((h) => h.row),
            `判据 ${rule.id}（01 行 ${rule.row}）未被命中`,
          ).toContain(rule.row);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    },
    // 16 条判据逐条 mkdtemp+扫描+清理，Windows 文件系统上贴近默认 5s 上限（P-006 同款时序敏感）
    { timeout: 30_000 },
  );

  it("负样本组：干净的样本零命中（防扫描器把什么都报红）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keel-scan-clean-"));
    try {
      await writePlugin(dir, "pkg/package.json", JSON.stringify({ name: "clean", private: true }));
      await writePlugin(
        dir,
        "pkg/entry.ts",
        [
          'import { defineCell } from "@keel/cell-runtime";',
          'import { helper } from "./helper.js";',
          'import { readFileSync } from "node:fs";',
          "export const tools = [{ name: 'echo', run: (x: string) => x }];",
          "",
        ].join("\n"),
      );
      const hits = await scanNativePlugins(dir);
      expect(hits).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("负样本组：干净的 engine / model 样本零命中（kind 规则不误伤）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keel-scan-clean-kinds-"));
    try {
      await writePlugin(dir, "engine/keel-plugin.json", JSON.stringify({ kind: "engine" }));
      await writePlugin(
        dir,
        "engine/entry.ts",
        [
          "export const tools = [];",
          "export function step(input: unknown) {",
          '  return { decision: { kind: "done", summary: "ok", input } };',
          "}",
          "",
        ].join("\n"),
      );
      await writePlugin(dir, "model/keel-plugin.json", JSON.stringify({ kind: "model" }));
      await writePlugin(
        dir,
        "model/entry.ts",
        [
          "export function create(opts: unknown) {",
          "  return {",
          "    invoke: async () => ({",
          "      result: {},",
          "      usage: { inputCached: 1, inputUncached: 2, output: 3 },",
          "      opts,",
          "    }),",
          "  };",
          "}",
          "",
        ].join("\n"),
      );
      const hits = await scanNativePlugins(dir);
      expect(hits).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("实扫组：packages/plugins 下零命中（目录缺失也红）", async () => {
    const hits = await scanNativePlugins(PLUGINS_DIR);
    expect(
      hits,
      `在库原生插件命中禁面：\n${hits.map((h) => `${h.file}:${h.line} [${h.row}] ${h.excerpt}`).join("\n")}`,
    ).toEqual([]);
  });
});
