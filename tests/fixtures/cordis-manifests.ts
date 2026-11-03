/**
 * 集成测试夹具的**声明侧**（切片④收口时从 `cordis-rig.ts` 拆出）：报关单组装、样本路径、
 * 可见表指纹与授权策略编译。都是纯函数——不碰进程、不碰账本，所以拆出来不留循环依赖。
 *
 * 为什么要有这一份：`cordis-rig.ts` 管的是"接线次序"（起舱 → 绑通道 → 建分区 → 探就绪 → 起 run），
 * 这一份管的是"喂进去什么声明"。两件事的关注点不同，合在一起就是一只 600 行红线的文件
 * （standards/08），而拆开后 rig 仍然只暴露一份入口（本文件的符号经 `cordis-rig.ts` 再导出，
 * 既有测试的 import 语句一行都不用改）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AuthRule, ToolEntry } from "@keel/core";
import {
  Assembler,
  manifestAuthRules,
  type CompensationTemplateDecl,
  type LoadedManifest,
  type PermissionDecl,
  type PolicySpec,
} from "@keel/host";

export const repoRoot = process.cwd();
const manifestSchema: object = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs", "design", "phase-1", "schema", "keel-plugin.schema.json"),
    "utf-8",
  ),
);

/** 可见表指纹（排序后的 `name@version`；driver 的断言与激活屏障都读它）。 */
export function fingerprint(entries: ToolEntry[]): string[] {
  return entries.map((t) => `${t.name}@${t.schemaVersion}`).sort();
}

export function names(entries: ToolEntry[]): string[] {
  return entries.map((t) => t.name).sort();
}

/** 报关单里的原始补偿模板形状（`class` 是输入侧字段名，与 assembler 一致）。 */
export interface RawTemplate {
  kind: string;
  class: CompensationTemplateDecl["compensationClass"];
  action: { type: "plugin" | "builtin"; ref: string };
  idempotency: CompensationTemplateDecl["idempotency"];
  probe?: { ref: string };
}

/** 组装旧插件用的 manifest（切片②才引入合成路径，本片按"已报关"给声明）。 */
export function legacyManifest(
  caps: PermissionDecl[] = [{ cap: "tool.provide" }],
  toolCallTimeoutMs = 5_000,
  templates: RawTemplate[] = [],
): LoadedManifest {
  return new Assembler({ schema: manifestSchema }).assemble({
    kind: "capability",
    meta: { name: `cordis-${caps.length}`, version: "1.0.0", title: "legacy", description: "x" },
    permissions: caps,
    resources: { toolCallTimeoutMs },
    compensation: { templates },
    compat: { keelContract: "^1.0" },
  });
}

export function fixtureFile(name: string): string {
  return path.join(repoRoot, "tests", "fixtures", "cordis-plugins", name);
}

/** fixtures 根目录下的**新生态**插件（.mjs，默认入口装载）——对照用，不参与零改动扫描。 */
export function coreFixtureFile(name: string): string {
  return path.join(repoRoot, "tests", "fixtures", name);
}

/** 策略样本模块（切片④，新生态形状：`export const hooks = {...}`）。 */
export function policyFixtureFile(name: string): string {
  return path.join(repoRoot, "tests", "fixtures", "policies", name);
}

/** 策略报关单：`kind:"policy"`，`hooks` 只能取四白名单值（schema 第 1 步硬约束）。 */
export function policyManifest(name: string, hooks: string[]): LoadedManifest {
  return new Assembler({ schema: manifestSchema }).assemble({
    kind: "policy",
    meta: { name, version: "1.0.0", title: name, description: "policy sample" },
    permissions: [],
    resources: {},
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
    hooks,
  });
}

/** 报关单 + 模块路径成对给出（名字 = 文件名去后缀，`meta.name` 要过 kebab-case pattern）。 */
export function policySpec(fileName: string, hooks: string[]): PolicySpec {
  return {
    manifest: policyManifest(`policy-${fileName.replace(/\.mjs$/, "")}`, hooks),
    modulePath: policyFixtureFile(fileName.endsWith(".mjs") ? fileName : `${fileName}.mjs`),
  };
}

/** 由声明编译策略 + 本 rig 固定的"工具执行放行"（tool.invoke 是 Core→Cell 方向，不属本片扩展面）。 */
export function policyFor(
  manifest: LoadedManifest,
  subject: string,
  extra: AuthRule[] = [],
): AuthRule[] {
  return [
    ...manifestAuthRules(manifest, subject),
    { subject: "*", action: "tool.invoke", resource: "*" },
    ...extra,
  ];
}
