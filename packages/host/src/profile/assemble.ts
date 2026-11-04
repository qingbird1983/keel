/**
 * Profile 装配编排（Phase 4 切片②，01 稿 P4/P7/P8；ADR-0022）。
 *
 * 六步（任一失败 = 整份拒绝，已起的 Cell 全部 drain，hook 零注册、run 不启动、账本零事件）：
 *   1. 读文件 → 严格 YAML 子集解析（`parse.ts`）
 *   2. profile schema 校验（未知字段拒绝，`schema.ts`）
 *   3. 逐插件读 manifest → **五步校验零豁免** → kind 交叉校验（`loadProfile`）
 *   4. 按 kind 分派隔离环境并拉起（capability/engine = Cell；policy = 策略舱；model = 宿主模块；
 *      observation = 无运行时）
 *   5. 逐 Cell 就绪凭据 = 一次 `cell.snapshot` 应答（ADR-0011，`wireCell`）
 *   6. 全部就绪后才注册 hook（`wirePolicies` 的整批注册），再由调用方 `run.start` 落装配记录
 *
 * **零加载保证（P5）**：只遍历 profile 的 `plugins` 数组；数组外的包不扫描、不 import、不起进程。
 * engine 的 `tools` 与工具归属用**真实注册结果**复核（`onToolChange`），不靠 manifest 猜。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  KeelError,
  scopeKey,
  type AssemblyRecordedPayload,
  type HookBus,
  type ModelPricing,
  type ModelUpstream,
  type RunRef,
  type Scope,
  type ToolExecutor,
} from "@keel/core";
import { Assembler } from "../assembler.js";
import { wireCell } from "../wire-cell.js";
import { wirePolicies, type PolicyBinding, type PolicySpec } from "../policy-link.js";
import type { CellServerDeps } from "../cell-server.js";
import type { CellSupervisor, SupervisedCell } from "../supervisor.js";
import { validateProfileDocument } from "./schema.js";
import { parseYamlSubset } from "./parse.js";
import type { LoadedManifest, ManifestKind } from "../assembler.js";

export interface ProfilePluginPlan {
  id: string;
  kind: ManifestKind;
  manifest: LoadedManifest;
  manifestPath: string;
  modulePath: string;
  scope: Scope;
}

export interface ProfilePlan {
  name: string;
  version: number;
  scope: Scope;
  plugins: ProfilePluginPlan[];
}

export interface LoadProfileOptions {
  /** `docs/design/phase-4/schema/keel-profile.schema.json` 内容。 */
  profileSchema: unknown;
  /** 已构造的 manifest 装配器（五步校验的唯一实现）。 */
  assembler: Assembler;
}

interface RawProfilePlugin {
  id: string;
  kind: ManifestKind;
  manifest: string;
  module: string;
  scope?: { agentId?: string; sessionId?: string };
}

interface RawProfile {
  version: number;
  name: string;
  scope?: { agentId?: string; sessionId?: string };
  plugins: RawProfilePlugin[];
}

function invalid(message: string, detail: Record<string, unknown>): KeelError {
  return new KeelError("SCHED/MANIFEST-INVALID", message, detail);
}

/** 相对路径（P3）：绝对路径拒绝——清单必须可移植、不得写本机路径。 */
function resolveRelative(baseDir: string, value: string, pluginId: string, field: string): string {
  if (
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("file:")
  ) {
    throw invalid(`profile path must be relative, absolute path refused (${field})`, {
      stage: "path",
      pluginId,
      field,
      value,
    });
  }
  return path.resolve(baseDir, value);
}

function readJson(file: string, pluginId: string, field: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw invalid(`cannot read ${field} for plugin "${pluginId}"`, {
      stage: "io",
      pluginId,
      field,
      path: file,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 1~3 步：解析 profile → schema → 逐 manifest 五步校验 + kind 交叉校验 + engine↔model 引用。
 * 本函数**不拉起任何运行时**，`keel validate --profile` 与 `keel run --profile` 共用。
 */
export function loadProfile(profilePath: string, opts: LoadProfileOptions): ProfilePlan {
  const absolute = path.resolve(profilePath);
  const baseDir = path.dirname(absolute);
  let raw: unknown;
  try {
    const text = readFileSync(absolute, "utf-8");
    raw = absolute.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYamlSubset(text);
  } catch (err) {
    if (err instanceof KeelError) throw err;
    throw invalid(`cannot read profile file`, {
      stage: "io",
      path: absolute,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const issues = validateProfileDocument(opts.profileSchema, raw);
  if (issues.length > 0) {
    throw invalid("profile failed schema validation", { stage: "schema", issues });
  }
  const profile = raw as RawProfile;

  const scope: Scope = {
    agentId: profile.scope?.agentId ?? profile.name,
    sessionId: profile.scope?.sessionId ?? "main",
  };
  const ids = new Set<string>();
  const plugins: ProfilePluginPlan[] = [];
  for (const p of profile.plugins) {
    if (ids.has(p.id)) {
      throw invalid(`duplicate plugin id "${p.id}"`, { stage: "cross-check", pluginId: p.id });
    }
    ids.add(p.id);
    const manifestPath = resolveRelative(baseDir, p.manifest, p.id, "manifest");
    const modulePath = resolveRelative(baseDir, p.module, p.id, "module");
    const manifest = opts.assembler.assemble(readJson(manifestPath, p.id, "manifest"));
    if (manifest.kind !== p.kind) {
      throw invalid(
        `profile kind "${p.kind}" does not match manifest kind "${manifest.kind}" for "${p.id}"`,
        { stage: "cross-check", pluginId: p.id, profileKind: p.kind, manifestKind: manifest.kind },
      );
    }
    plugins.push({
      id: p.id,
      kind: p.kind,
      manifest,
      manifestPath,
      modulePath,
      scope: {
        agentId: p.scope?.agentId ?? scope.agentId,
        sessionId: p.scope?.sessionId ?? scope.sessionId,
      },
    });
  }

  // 模型名在**一份 profile 内**必须唯一：engine 只按模型名调用，同名 = 上游不可判定。
  const servedBy = new Map<string, string>();
  for (const p of plugins) {
    if (p.kind !== "model") continue;
    for (const name of p.manifest.model?.models ?? []) {
      const prev = servedBy.get(name);
      if (prev !== undefined) {
        throw invalid(`model name "${name}" is served twice in this profile`, {
          stage: "cross-check",
          model: name,
          plugins: [prev, p.id],
        });
      }
      servedBy.set(name, p.id);
    }
  }

  // engine → model 引用校验（03 稿 E9）：ref 必须命中 model 插件，name 必须在该插件 models 里。
  for (const p of plugins) {
    if (p.kind !== "engine") continue;
    const engine = p.manifest.engine as NonNullable<LoadedManifest["engine"]>;
    const target = plugins.find((q) => q.id === engine.model.ref);
    if (!target || target.kind !== "model") {
      throw invalid(`engine "${p.id}" model.ref does not name a model plugin`, {
        stage: "cross-check",
        pluginId: p.id,
        modelRef: engine.model.ref,
      });
    }
    const models = target.manifest.model?.models ?? [];
    if (!models.includes(engine.model.name)) {
      throw invalid(`engine "${p.id}" model.name is not served by "${target.id}"`, {
        stage: "cross-check",
        pluginId: p.id,
        modelRef: target.id,
        modelName: engine.model.name,
        models,
      });
    }
  }

  return { name: profile.name, version: profile.version, scope, plugins };
}

export interface AssembleProfileOptions {
  supervisor: CellSupervisor;
  deps: CellServerDeps;
  /** 本 profile 服务的 run（Cell ↔ Run 一一对应，契约 §3.2）。 */
  runId: string;
  /** profile 含 policy 时必填：插话总线与策略舱入口。 */
  policy?: {
    bus: HookBus;
    entryPath: string;
    hookTimeoutMs?: number;
    readyTimeoutMs?: number;
  };
  /** 密钥解析面（02 稿 M6）：per-request resolve；缺省读 `process.env`。 */
  secretResolver?: (ref: string) => string | undefined;
  /** 动态 import 注入位（测试用；缺省 `import(pathToFileURL)`）。 */
  importer?: (url: string) => Promise<unknown>;
  readyTimeoutMs?: number;
}

export interface AssembledProfilePlugin extends ProfilePluginPlan {
  ref: RunRef;
  /** capability / engine 的 Cell；model 无（宿主模块由 `upstream` 承载）。 */
  cell?: SupervisedCell;
  /** model 的宿主上游实例。 */
  upstream?: ModelUpstream;
}

export interface ProfileAssembly {
  plan: ProfilePlan;
  ref: RunRef;
  plugins: AssembledProfilePlugin[];
  /**
   * engine 条目（Phase 4 切片④）：`engine.step` 的 Cell 与报关单声明。
   * 驱动由调用方经 `new EngineDriver({cell, engine: decl, ledger, ref})` 组装；
   * profile 不含 engine 时缺省（旧路径不受影响）。
   */
  engine?: { pluginId: string; cell: SupervisedCell; decl: NonNullable<LoadedManifest["engine"]> };
  /** 需要 attachRun 的 Cell（按声明序）。 */
  cells: { cell: SupervisedCell; ref: RunRef }[];
  policies: PolicyBinding[];
  /** 逐插件装配记录（声明序；`profile` / `plugin` 已追加）。 */
  records: AssemblyRecordedPayload[];
  /** 跨 capability Cell 的工具路由（按 run scope 分区）。 */
  executor: ToolExecutor;
  /** 收束本装配拉起的所有进程（含策略舱）；幂等。 */
  close(): Promise<void>;
}

interface ToolOwner {
  pluginId: string;
  cell: SupervisedCell;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function defaultImporter(url: string): Promise<unknown> {
  return import(url);
}

/**
 * 第 4~6 步：按 kind 拉起 → 全部就绪 → 复核工具归属 → 最后才注册策略 hook。
 * 任何一步失败 = 已起的 Cell 全部收干净再抛出（整份拒绝，01 稿 §5）。
 */
export async function assembleProfile(
  plan: ProfilePlan,
  opts: AssembleProfileOptions,
): Promise<ProfileAssembly> {
  const runRef: RunRef = { ...plan.scope, runId: opts.runId };
  const runScope = scopeKey(plan.scope);
  const owners = new Map<string, ToolOwner>();
  const duplicates: string[] = [];
  const spawned: SupervisedCell[] = [];
  const policySpecs: PolicySpec[] = [];
  const plugins: AssembledProfilePlugin[] = plan.plugins.map((p) => ({
    ...p,
    ref: { ...p.scope, runId: opts.runId },
  }));
  let policies: PolicyBinding[] = [];
  const secretResolver = opts.secretResolver ?? ((ref: string) => process.env[ref]);
  const importModule = opts.importer ?? defaultImporter;

  try {
    for (const p of plugins) {
      if (p.kind === "observation") continue; // 无运行时：不 import、不起进程（P7/P5）
      if (p.kind === "policy") {
        // 策略舱留到全部非策略插件就绪之后（第 6 步：先就绪、后注册）
        policySpecs.push({ manifest: p.manifest, modulePath: p.modulePath });
        continue;
      }
      if (p.kind === "model") {
        const mod = asRecord(await importModule(pathToFileURL(p.modulePath).href));
        const create = mod?.create;
        if (typeof create !== "function") {
          throw invalid(`model module must export create({model, secrets})`, {
            stage: "module",
            pluginId: p.id,
          });
        }
        const created = await (create as (input: unknown) => Promise<unknown> | unknown)({
          model: p.manifest.model,
          secrets: { resolve: secretResolver },
        });
        const upstream = asRecord(created);
        if (!upstream || typeof upstream.invoke !== "function") {
          throw invalid(`model module create() must return a ModelUpstream with invoke()`, {
            stage: "module",
            pluginId: p.id,
          });
        }
        p.upstream = created as ModelUpstream;
        // 费用权威在 Core（02 稿 M3/§5）：价格表随注册交给网关，模块之后只报用量。
        // 一个模块可服务多个模型名，价格按名分别声明（manifest 已校验键集合 = models）。
        const decl = p.manifest.model as NonNullable<LoadedManifest["model"]>;
        for (const name of decl.models) {
          opts.deps.gateway.registerModel(
            {
              models: [name],
              upstream: p.upstream,
              pricing: decl.pricing[name] as ModelPricing,
            },
            // 一份 profile 内同名模型由 loadProfile 拒绝；跨 profile/跨装配（同一宿主进程里
            // 多次装配）按"这次装配是这份 run 的权威上游"重绑，不让上一次装配的模块残留。
            { replace: true },
          );
        }
        continue;
      }
      // capability / engine：Cell 进程 + 就绪凭据（ADR-0011）
      const { cell } = await wireCell({
        supervisor: opts.supervisor,
        deps: opts.deps,
        scope: p.scope,
        ref: p.ref,
        subject: p.scope.agentId,
        manifest: p.manifest,
        pluginPath: p.modulePath,
        ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
        onToolChange: (changedCell, change) => {
          const key = `${scopeKey(p.scope)}\u0000${change.name}`;
          if (!change.registered) {
            if (owners.get(key)?.cell === changedCell) owners.delete(key);
            return;
          }
          const prev = owners.get(key);
          if (prev && prev.cell !== changedCell) {
            duplicates.push(`${change.name} (${prev.pluginId} and ${p.id})`);
          }
          owners.set(key, { pluginId: p.id, cell: changedCell });
        },
      });
      p.cell = cell;
      spawned.push(cell);
    }

    // 工具归属复核（03 稿 E9）：重名 = 整份拒绝；engine.tools 必须恰好一个提供者。
    if (duplicates.length > 0) {
      throw invalid("two profile plugins provide the same tool name", {
        stage: "cross-check",
        duplicates,
      });
    }
    for (const p of plugins) {
      if (p.kind !== "engine") continue;
      const engine = p.manifest.engine as NonNullable<LoadedManifest["engine"]>;
      for (const tool of engine.tools) {
        const owner = owners.get(`${scopeKey(p.scope)}\u0000${tool}`);
        if (!owner) {
          throw invalid(`engine tool "${tool}" is not provided by any capability plugin`, {
            stage: "cross-check",
            pluginId: p.id,
            tool,
          });
        }
      }
    }

    // 第 6 步：全部就绪之后才接策略（整批注册；冲突 = 整份拒绝）
    if (policySpecs.length > 0) {
      if (!opts.policy) {
        throw invalid("profile declares policy plugins but no hook bus was provided", {
          stage: "policy",
        });
      }
      policies = await wirePolicies({
        supervisor: opts.supervisor,
        bus: opts.policy.bus,
        specs: policySpecs,
        policyEntryPath: opts.policy.entryPath,
        ...(opts.policy.hookTimeoutMs !== undefined
          ? { hookTimeoutMs: opts.policy.hookTimeoutMs }
          : {}),
        ...(opts.policy.readyTimeoutMs !== undefined
          ? { readyTimeoutMs: opts.policy.readyTimeoutMs }
          : {}),
      });
    }
  } catch (err) {
    await Promise.allSettled(spawned.map((c) => c.drainAndReap()));
    throw err;
  }

  const cells = plugins.flatMap((p) => (p.cell ? [{ cell: p.cell, ref: p.ref }] : []));
  const executor: ToolExecutor = async (call) => {
    const owner = owners.get(`${runScope}\u0000${call.tool}`);
    if (!owner) {
      return {
        status: "error",
        error: {
          code: "SCHED/NOT-FOUND",
          message: `no profile plugin in this scope provides tool "${call.tool}"`,
        },
      };
    }
    return owner.cell.executor(call);
  };
  const records: AssemblyRecordedPayload[] = plan.plugins.map((p) => ({
    ...p.manifest.record,
    profile: { name: plan.name, version: plan.version },
    plugin: { id: p.id },
  }));

  const enginePlugin = plugins.find((p) => p.kind === "engine");
  const engine =
    enginePlugin?.cell && enginePlugin.manifest.engine
      ? { pluginId: enginePlugin.id, cell: enginePlugin.cell, decl: enginePlugin.manifest.engine }
      : undefined;

  let closed = false;
  return {
    plan,
    ref: runRef,
    plugins,
    ...(engine ? { engine } : {}),
    cells,
    policies,
    records,
    executor,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([
        ...spawned.map((c) => c.drainAndReap()),
        ...policies.map((b) => b.cell.drainAndReap()),
      ]);
    },
  };
}
