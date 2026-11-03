/**
 * 装配器五步校验 —— manifest 稿 §6（fail-closed，C-M3）：任一步失败 = 拒绝装配
 * （SCHED/MANIFEST-INVALID），未声明的能力不存在。
 *
 * 1. 结构校验（draft 2020-12 关键词子集校验器，schema 内容由调用方注入）
 * 2. 权限交叉：越界能力（net.fetch/fs.write/memory.backend）allow 必填 + 补偿模板非空
 * 3. 资源：toolCallTimeoutMs ≤ 契约 §7 上限（语义层复核；C-D3）
 * 4. 版本：compat.keelContract 范围含当前契约版本；升级场景另验 migration.from 匹配已装版本
 * 5. 记录：产出 AssemblyRecordedPayload 载荷（scheduler 于 run.start 首事件落账，切片③注记）
 */

import { CONTRACT_VERSION, KeelError, type AssemblyRecordedPayload } from "@keel/core";
import { BUILTIN_REFS, RECORD_ONLY_REF } from "./builtins.js";
import { validateSchema } from "./schema-validator.js";

export const KINDS = ["capability", "policy", "observation"] as const;
export type ManifestKind = (typeof KINDS)[number];

/**
 * 越界能力词表（manifest 稿 §5.2：必须 allow 必填 + 补偿模板非空）。
 * 导出原因：合成器（`@keel/cordis-adapter`）据此判定"合不出补偿 → 进缺项清单"，
 * 两处必须是同一份名单——分开维护就会出现"校验要求补偿而合成不知道"的漂移。
 */
export const BOUNDARY_CAPS = new Set(["net.fetch", "fs.write", "memory.backend"]);

/** 契约 §7 上限（与 Schema maximum 一致；语义层复核）。 */
export const TOOL_CALL_TIMEOUT_MAX_MS = 600_000;

export interface PermissionDecl {
  cap: string;
  allow?: string[];
  reason?: string;
}

export interface CompensationTemplateDecl {
  kind: string;
  compensationClass: "reversible" | "mitigable" | "record-only";
  action: { type: "plugin" | "builtin"; ref: string };
  idempotency: "natural" | "keyed" | "probe-guarded";
  probe?: { ref: string };
}

export interface GovernanceGuardDecl {
  cap: "fs.read" | "fs.write";
  from: string;
  prefix?: string;
}

export interface GovernanceEffectDecl {
  kind: string;
  targetFields: string[];
  digestFields?: string[];
}

export interface GovernanceToolDecl {
  name: string;
  guard?: GovernanceGuardDecl;
  effects?: GovernanceEffectDecl[];
}

export interface MigrationDecl {
  from: string;
  steps: { to: string; action: { type: "hook"; ref: string } }[];
}

/** manifest 原始形（Schema 校验通过后的形状）。 */
interface RawManifest {
  kind: ManifestKind;
  meta: { name: string; version: string; title: string; description: string };
  permissions: PermissionDecl[];
  resources: { toolCallTimeoutMs?: number; memoryMbSoft?: number; maxToolCallsPerRound?: number };
  compensation: { templates: RawTemplate[] };
  compat: { keelContract: string };
  migration?: MigrationDecl;
  hooks?: string[];
  subscriptions?: string[];
  /** 可选：信任申请（ADR-0019）；raw 需宿主授予。 */
  trust?: { rawIo?: boolean };
  /** capability 专用治理切面（ADR-0015）。 */
  governance?: { tools: GovernanceToolDecl[] };
}

interface RawTemplate {
  kind: string;
  class: CompensationTemplateDecl["compensationClass"];
  /** record-only 可省略（装配器归一为 builtin/record-only）；其余类由 Schema 条件必填。 */
  action?: { type: "plugin" | "builtin"; ref: string };
  /** record-only 可省略（归一 natural）；其余类由 Schema 条件必填。 */
  idempotency?: CompensationTemplateDecl["idempotency"];
  probe?: { ref: string };
}

/** 装配产物：结构化视图 + 审计记录（run 装配的唯一凭据）。 */
export interface LoadedManifest {
  kind: ManifestKind;
  meta: RawManifest["meta"];
  permissions: PermissionDecl[];
  resources: RawManifest["resources"];
  templates: CompensationTemplateDecl[];
  migration: MigrationDecl | null;
  hooks: string[];
  subscriptions: string[];
  /** 治理切面声明（无 = null；宿主据此编译 CellGovernancePlan）。 */
  governance: GovernanceToolDecl[] | null;
  /** 宿主授予的信任层级（ADR-0019；缺省 mediated）。 */
  trust: "mediated" | "raw";
  compat: RawManifest["compat"];
  /** ASSEMBLY_RECORDED 载荷（装配清单入账本，manifest 稿 §6 第 5 步）。 */
  record: AssemblyRecordedPayload;
}

export interface AssemblerOptions {
  /** keel-plugin.schema.json 内容（draft 2020-12；调用方从仓库路径加载注入）。 */
  schema: unknown;
  /** 当前 Core 契约版本（缺省 @keel/core CONTRACT_VERSION）。 */
  contractVersion?: string;
  /**
   * 是否授予 manifest 的 raw IO 信任申请（ADR-0019）。缺省 false：申请了也拒绝装配，
   * 不把“申请”当“授予”；宿主/评审显式打开才放行。
   */
  allowRawIo?: boolean;
}

function invalid(message: string, detail: unknown): KeelError {
  return new KeelError("SCHED/MANIFEST-INVALID", message, detail);
}

export class Assembler {
  private readonly schema: unknown;
  private readonly contractVersion: string;
  private readonly allowRawIo: boolean;

  constructor(opts: AssemblerOptions) {
    this.schema = opts.schema;
    this.contractVersion = opts.contractVersion ?? CONTRACT_VERSION;
    this.allowRawIo = opts.allowRawIo ?? false;
  }

  /** 五步校验；返回装配产物。 */
  assemble(raw: unknown, replacesVersion?: string): LoadedManifest {
    const m = this.validate(raw, replacesVersion);
    const trust: "mediated" | "raw" = m.trust?.rawIo === true ? "raw" : "mediated";
    return {
      kind: m.kind,
      meta: m.meta,
      permissions: m.permissions,
      resources: m.resources,
      templates: m.compensation.templates.map((t) => ({
        kind: t.kind,
        compensationClass: t.class,
        action: t.action ?? { type: "builtin" as const, ref: RECORD_ONLY_REF },
        idempotency: t.idempotency ?? "natural",
        ...(t.probe ? { probe: t.probe } : {}),
      })),
      migration: m.migration ?? null,
      hooks: m.hooks ?? [],
      subscriptions: m.subscriptions ?? [],
      governance: m.governance?.tools ?? null,
      trust,
      compat: m.compat,
      record: {
        manifest: { name: m.meta.name, version: m.meta.version, kind: m.kind },
        permissions: m.permissions.map((p) => ({
          cap: p.cap,
          ...(p.allow ? { allow: p.allow } : {}),
        })),
        compensation: m.compensation.templates.map((t) => ({
          kind: t.kind,
          compensationClass: t.class,
          idempotency: t.idempotency ?? "natural",
        })),
        ...(trust === "raw" ? { trust } : {}),
        ...(replacesVersion !== undefined ? { replacesVersion } : {}),
      },
    };
  }

  /** 五步顺序校验（私有；任一步失败即抛）。 */
  private validate(raw: unknown, replacesVersion?: string): RawManifest {
    // 第 1 步：结构校验（Schema 子集）
    const issues = validateSchema(this.schema, raw);
    if (issues.length > 0) {
      throw invalid("manifest failed schema validation", { issues });
    }
    const m = raw as RawManifest;

    // 第 1 步补充（切片③，ADR-0015）：治理切面的语义校验（Schema 无法表达的部分）
    if (m.governance) this.validateGovernance(m);

    // 第 1 步补充（R5，ADR-0019）：raw IO 是“申请 + 授予”，申请不等于授予
    if (m.trust?.rawIo === true && !this.allowRawIo) {
      throw invalid("raw IO trust requested but not granted by host", {
        plugin: m.meta.name,
        requested: "rawIo",
      });
    }

    // 第 2 步：权限交叉校验（语义层——Schema 不强制 allow 必填性，C-M2 分层）
    for (const p of m.permissions) {
      if (BOUNDARY_CAPS.has(p.cap) && (!p.allow || p.allow.length === 0)) {
        throw invalid(`boundary capability "${p.cap}" requires allow qualifiers`, { cap: p.cap });
      }
    }
    if (
      m.permissions.some((p) => BOUNDARY_CAPS.has(p.cap)) &&
      m.compensation.templates.length === 0
    ) {
      throw invalid("boundary capabilities require at least one compensation template", {
        caps: m.permissions.map((p) => p.cap),
      });
    }

    // 第 2 步补充（切片③，ADR-0016）：补偿动作类型与内建闭集
    for (const t of m.compensation.templates) {
      if (t.class !== "record-only" && (!t.action || !t.idempotency)) {
        throw invalid("non record-only compensation template requires action and idempotency", {
          kind: t.kind,
          compensationClass: t.class,
        });
      }
      if (t.action?.type === "builtin") {
        if (!BUILTIN_REFS.has(t.action.ref)) {
          throw invalid(`unknown builtin compensation ref "${t.action.ref}"`, {
            kind: t.kind,
            ref: t.action.ref,
            known: [...BUILTIN_REFS],
          });
        }
        if (t.action.ref === RECORD_ONLY_REF && t.class !== "record-only") {
          throw invalid(`builtin "${RECORD_ONLY_REF}" requires class record-only`, {
            kind: t.kind,
            compensationClass: t.class,
          });
        }
      }
    }

    // 第 3 步：资源校验（toolCallTimeoutMs 硬上限，契约 §7）
    if (m.kind === "capability") {
      const t = m.resources.toolCallTimeoutMs;
      if (typeof t !== "number" || t <= 0) {
        throw invalid("capability requires positive toolCallTimeoutMs", { toolCallTimeoutMs: t });
      }
      if (t > TOOL_CALL_TIMEOUT_MAX_MS) {
        throw invalid("toolCallTimeoutMs exceeds contract §7 maximum", {
          toolCallTimeoutMs: t,
          max: TOOL_CALL_TIMEOUT_MAX_MS,
        });
      }
    }

    // 第 4 步：版本校验（宿主契约协商 + 升级迁移范围）
    if (!rangeContains(m.compat.keelContract, this.contractVersion)) {
      throw invalid("compat.keelContract does not include current contract version", {
        declared: m.compat.keelContract,
        current: this.contractVersion,
      });
    }
    if (replacesVersion !== undefined && m.migration) {
      if (!rangeContains(m.migration.from, replacesVersion)) {
        throw invalid("migration.from does not match installed version", {
          migrationFrom: m.migration.from,
          installed: replacesVersion,
        });
      }
    }
    return m;
  }

  /**
   * 治理声明语义校验（ADR-0015）：只做 Schema 表达不了的部分。
   * 绑定是否真的存在（工具名）留给 Cell 的 markReady；这里保证“声明本身自洽”。
   */
  private validateGovernance(m: RawManifest): void {
    if (m.kind !== "capability") {
      throw invalid("governance is only allowed for capability manifests", { kind: m.kind });
    }
    const tools = m.governance?.tools ?? [];
    const names = new Set<string>();
    const templateKinds = new Set(m.compensation.templates.map((t) => t.kind));
    for (const tool of tools) {
      if (names.has(tool.name)) {
        throw invalid(`duplicate governance tool "${tool.name}"`, { name: tool.name });
      }
      names.add(tool.name);
      if (!tool.guard && (!tool.effects || tool.effects.length === 0)) {
        throw invalid(`governance tool "${tool.name}" needs guard or effects`, { name: tool.name });
      }
      if (tool.guard) {
        const decl = m.permissions.find((p) => p.cap === tool.guard?.cap);
        if (!decl || !decl.allow || decl.allow.length === 0) {
          throw invalid(
            `governance guard "${tool.guard.cap}" requires a permission with non-empty allow`,
            { name: tool.name, cap: tool.guard.cap },
          );
        }
      }
      for (const e of tool.effects ?? []) {
        if (!templateKinds.has(e.kind)) {
          throw invalid(`governance effect kind "${e.kind}" has no compensation template`, {
            name: tool.name,
            kind: e.kind,
            templates: [...templateKinds],
          });
        }
        if (new Set(e.targetFields).size !== e.targetFields.length) {
          throw invalid(`governance targetFields of "${tool.name}" contain duplicates`, {
            name: tool.name,
            targetFields: e.targetFields,
          });
        }
        if (e.digestFields && new Set(e.digestFields).size !== e.digestFields.length) {
          throw invalid(`governance digestFields of "${tool.name}" contain duplicates`, {
            name: tool.name,
            digestFields: e.digestFields,
          });
        }
      }
    }
  }
}

/**
 * semver 范围含版本判定（Schema pattern 已约束形态：`^x.y` / `~x.y` / `>=x.y` / 裸精确）。
 * `^1.0` = [1.0.0, 2.0.0)；`~1.0` = [1.0.0, 1.1.0)；`>=1.0` = [1.0.0, ∞)；裸 `1.0` = 1.0.0 精确。
 */
export function rangeContains(range: string, version: string): boolean {
  const r = /^(\^|~|>=)?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range);
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!r || !v) return false;
  const op = r[1] ?? "";
  const base = [Number(r[2]), Number(r[3]), Number(r[4] ?? 0)] as const;
  const ver = [Number(v[1]), Number(v[2]), Number(v[3])] as const;
  const cmp = compare3(ver, base);
  if (op === "") return cmp === 0;
  if (cmp < 0) return false;
  if (op === "^") return ver[0] === base[0];
  if (op === "~") return ver[0] === base[0] && ver[1] === base[1];
  return true; // >=
}

function compare3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
