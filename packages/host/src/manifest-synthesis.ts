/**
 * 声明合成（Phase 2 切片②，03 稿 §3/§4）——把**观察账本**投影成一份候选报关单。
 *
 * 支点（F4）：内核拒绝一次越权调用时已经写下完整事实（`subject × action × resource × policyVersion × reason`），
 * 所以"插件想要什么"不需要先放行就能读到。合成器因此**只读账本，不碰任何裁决**：
 * 它是投影函数，不是权限来源。
 *
 * 三条硬口径（稿内 §4）：
 * - allow 只到观察到的资源为止，不做通配扩展；去重 + 排序，同一插件两次观察产出**字节相同**的候选；
 * - 越界能力（`BOUNDARY_CAPS`）需要补偿模板，而模板是插件作者的知识 → **一律进缺项清单，绝不代造**；
 * - 观察不到的面（舱内原生 `fetch`/`fs`/SDK 直调，F5）作为固定缺项写出，不得沉默省略。
 */

import { CONTRACT_VERSION, type LedgerEvent } from "@keel/core";
import { BOUNDARY_CAPS } from "./assembler.js";

/** 观察到的 action → 需要的能力声明（词表封闭；表外 action 不产声明，因为不存在对应 cap）。 */
export const OBSERVED_ACTION_CAPS: Record<string, string> = {
  "tool.register": "tool.provide",
  "tool.remove": "tool.provide",
  "model.invoke": "model.adapter",
  "net.fetch": "net.fetch",
  "fs.read": "fs.read",
  "fs.write": "fs.write",
};

/** 缺项种类（写进 gaps 报告，也是人工审核的待办清单）。 */
export type GapCode =
  | "COMPENSATION_TEMPLATE_REQUIRED"
  | "UNOBSERVABLE_NATIVE_IO"
  | "HANDLER_NOT_COVERED"
  | "TOOL_CALL_TIMEOUT_UNKNOWN";

export interface SynthesisGap {
  code: GapCode;
  detail: string;
}

export interface SynthesisInput {
  /** 观察运行的全部账本事件（多趟合在一起传也可，内部按事实合并去重）。 */
  events: LedgerEvent[];
  /** 插件文件路径（合成 meta.name 用；只取文件名，不写本机绝对路径）。 */
  pluginFile: string;
  /** 观察趟次的 runId（写进 description 作为来源凭据）。 */
  observedRunIds: string[];
  /**
   * 候选的单次工具调用超时。观察期看不出插件"真实"耗时需求，
   * 故这是**待审项**而不是结论：缺项清单里必须写明它来自宿主默认值（稿内 §12 限制 2）。
   */
  defaultToolCallTimeoutMs?: number;
}

export interface SynthesizedCandidate {
  /** 候选 manifest 原始 JSON（交给 Assembler 走五步校验；不过即拒绝装配）。 */
  raw: Record<string, unknown>;
  /** 观察到的工具名（排序去重）。 */
  toolNames: string[];
  /** 观察到的能力（词表顺序稳定）。 */
  caps: string[];
  gaps: SynthesisGap[];
}

const WORD_ORDER = [
  "tool.provide",
  "model.adapter",
  "net.fetch",
  "fs.read",
  "fs.write",
  "memory.backend",
] as const;

/** `1.0.0` → `^1.0`：候选只声明"当前契约的小版本范围"，跨大版本要人工确认。 */
export function contractRange(version: string = CONTRACT_VERSION): string {
  const [major, minor] = version.split(".");
  return `^${major}.${minor}`;
}

/** 插件文件名 → schema 合法的 kebab-case 名（`^[a-z][a-z0-9-]*$`）。 */
export function synthesizeName(pluginFile: string): string {
  const base = pluginFile.split(/[\\/]/).pop() ?? "plugin";
  const cleaned = base
    .replace(/\.(c|m)?js$/, "")
    .replace(/\.(c|m)?ts$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-0-9]+/, "")
    .replace(/-+$/, "");
  return cleaned.length > 0 ? `legacy-${cleaned}` : "legacy-plugin";
}

export function synthesizeManifest(input: SynthesisInput): SynthesizedCandidate {
  const perCap = new Map<string, Set<string>>();
  const toolNames = new Set<string>();
  const gaps: SynthesisGap[] = [];

  const add = (cap: string, resource?: string): void => {
    if (!perCap.has(cap)) perCap.set(cap, new Set());
    if (resource !== undefined && resource.length > 0) perCap.get(cap)!.add(resource);
  };

  for (const e of input.events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === "AUTH_DENIED") {
      const action = String(p.action ?? "");
      const resource = typeof p.resource === "string" ? p.resource : "";
      const cap = OBSERVED_ACTION_CAPS[action];
      if (cap) add(cap, cap === "tool.provide" ? resource : resource);
      continue;
    }
    if (e.type === "TOOL_SCHEMA_CHANGED") {
      const tool = typeof p.tool === "string" ? p.tool : "";
      if (tool) {
        add("tool.provide", tool);
        toolNames.add(tool);
      }
      continue;
    }
    if (e.type === "TOOL_RESULT" && p.status !== "ok") {
      // 这一条不是失败，是**覆盖度事实**：该工具的 handler 没跑到底，它内部的调用面这次看不见
      gaps.push({
        code: "HANDLER_NOT_COVERED",
        detail: `工具 ${String(p.tool ?? "?")} 本次状态为 ${String(p.status)}，其内部调用面未纳入观察（人工确认是否需要补声明）`,
      });
    }
  }

  for (const name of perCap.get("tool.provide") ?? []) toolNames.add(name);

  const caps = WORD_ORDER.filter((c) => perCap.has(c));
  for (const cap of caps) {
    if (BOUNDARY_CAPS.has(cap)) {
      gaps.push({
        code: "COMPENSATION_TEMPLATE_REQUIRED",
        detail: `越界能力 ${cap} 需要补偿模板（五步校验第 2 步），模板内容属插件作者知识——合成不代造`,
      });
    }
  }
  // 固定缺项：不经通道的调用面观察不到（03 稿 F5 / §12 限制 1）
  gaps.push({
    code: "UNOBSERVABLE_NATIVE_IO",
    detail:
      "舱内原生 fetch / fs / 模型 SDK 直调不经内核通道，本候选对它们**没有**任何依据；" +
      "需要这些能力请人工补声明（net.fetch/fs.* + allow 清单），并注意边界表 #4/#12 已改判 C 档",
  });

  const timeout = input.defaultToolCallTimeoutMs ?? 30_000;
  gaps.push({
    code: "TOOL_CALL_TIMEOUT_UNKNOWN",
    detail: `resources.toolCallTimeoutMs=${timeout} 取自宿主默认值：观察期看不出真实耗时需求，请人工确认`,
  });

  const permissions = caps.map((cap) => {
    const allow = [...(perCap.get(cap) ?? [])].sort();
    return allow.length > 0 ? { cap, allow } : { cap };
  });

  const name = synthesizeName(input.pluginFile);
  const raw = {
    kind: "capability",
    meta: {
      name,
      version: "0.0.0", // 合成版本不是发布版本：转正时由作者改写（03 稿 §4）
      title: name,
      description: `synthesized from observation: ${
        input.observedRunIds.join(", ") || "no-run"
      }`.slice(0, 400),
    },
    permissions,
    resources: { toolCallTimeoutMs: timeout },
    compensation: { templates: [] },
    compat: { keelContract: contractRange() },
  };

  return {
    raw,
    toolNames: [...toolNames].sort(),
    caps,
    gaps: gaps.sort((a, b) => a.code.localeCompare(b.code)),
  };
}
