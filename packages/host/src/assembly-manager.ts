/**
 * 装配编排 —— manifest 稿 §6 热装配切换时序（V5 正面表达）：
 *
 *   新版本 manifest → 五步校验 → 新 Cell spawn → context.alloc 新 scope
 *     → 迁移钩（如有，新 Cell 内）→ 原子作用域切换 → 旧 Cell drain → reaped
 *   任一步失败 → 新 Cell 丢弃，旧作用域不动（回退）
 *
 * 全程无全局注册表突变——被切换的只有本表的作用域绑定；审计 = ASSEMBLY_RECORDED
 * （随下一次 run.start 落账，见契约 §5 注记）。
 * Cell 实例经 CellFactory 抽象注入（真实实现 = Supervisor；测试用内存替身）。
 */

import { KeelError, scopeKey, type AssemblyRecordedPayload, type Scope } from "@keel/core";
import type { Assembler, LoadedManifest } from "./assembler.js";

/** 装配编排所需的 Cell 最小面（真实实现见 Supervisor.spawnCell 返回值）。 */
export interface ManagedCell {
  /** A5 迁移钩：新 Cell 内、快照挂载后首轮前执行；失败即回退。 */
  migrate(oldState: unknown): Promise<unknown>;
  /** 丢弃/收束（kill + reaped）。 */
  dispose(): Promise<void>;
}

export interface CellFactory {
  spawn(spec: { manifest: LoadedManifest; pluginPath: string }): ManagedCell;
}

export interface ScopeBinding {
  manifest: LoadedManifest;
  cell: ManagedCell;
  /**
   * Supervisor 持有的作用域状态（D3：热装配迁移钩出入参内存槽；运行中快照经
   * SnapshotStore 持有 + STATE_SNAPSHOT_REF 元数据入账本，切片④）。
   */
  state: unknown;
}

export interface BindRequest {
  manifest: LoadedManifest;
  pluginPath: string;
}

export interface HotSwapRequest {
  /** 新版本 manifest 原始 JSON（五步校验在此执行）。 */
  rawManifest: unknown;
  pluginPath: string;
}

export class AssemblyManager {
  private readonly deps: { assembler: Assembler; factory: CellFactory };
  private readonly bindings = new Map<string, ScopeBinding>();

  constructor(deps: { assembler: Assembler; factory: CellFactory }) {
    this.deps = deps;
  }

  /** 初次装配：spawn + 作用域绑定；同 scope 重复 bind 拒绝（CTX/SCOPE-EXISTS）。 */
  bind(scope: Scope, req: BindRequest): ScopeBinding {
    const key = scopeKey(scope);
    if (this.bindings.has(key)) {
      throw new KeelError("CTX/SCOPE-EXISTS", "scope already bound", { scope });
    }
    const cell = this.deps.factory.spawn({ manifest: req.manifest, pluginPath: req.pluginPath });
    const binding: ScopeBinding = { manifest: req.manifest, cell, state: null };
    this.bindings.set(key, binding);
    return binding;
  }

  current(scope: Scope): ScopeBinding | null {
    return this.bindings.get(scopeKey(scope)) ?? null;
  }

  /**
   * 热装配升级：五步校验 → 新 Cell → 迁移钩（如有）→ 原子换绑。
   * 失败 = 新 Cell 丢弃、旧绑定原样（回退，V5）；旧 Cell 的收束由调用方在
   * 其 run 结束后 dispose（drain 语义随切片④恢复链路接入）。
   */
  async hotSwap(scope: Scope, req: HotSwapRequest): Promise<{ record: AssemblyRecordedPayload }> {
    const key = scopeKey(scope);
    const current = this.bindings.get(key);
    // 五步校验（含升级场景的 migration.from 匹配已装版本）
    const manifest = this.deps.assembler.assemble(req.rawManifest, current?.manifest.meta.version);
    const newCell = this.deps.factory.spawn({ manifest, pluginPath: req.pluginPath });
    try {
      let state: unknown = null;
      if (manifest.migration) {
        // 迁移钩在新 Cell 内执行；入参 = 旧版本状态快照（Host 持有）
        state = await newCell.migrate(current?.state ?? null);
      }
      // 原子换绑（单线程事件循环内同步完成）
      this.bindings.set(key, { manifest, cell: newCell, state });
    } catch (err) {
      await newCell.dispose(); // 新 Cell 丢弃，旧作用域不动
      throw new KeelError("SCHED/MANIFEST-INVALID", "hot swap rolled back: migration hook failed", {
        scope,
        version: manifest.meta.version,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    return { record: manifest.record };
  }
}
