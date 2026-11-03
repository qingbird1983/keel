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
  /**
   * 丢弃/收束。真实实现 = `Supervisor.drainAndReap()`（拒新 → 等在途 → 宽限强杀 → reaped，
   * 切片⑤ §3.3）；返回值是 `DrainOutcome`，编排层不消费，故这里只声明 unknown（测试替身可返回 void）。
   */
  dispose(): Promise<unknown>;
}

export interface CellFactory {
  /**
   * `cellEntry`（切片②）：被编排的舱可以是承接层入口（存量插件）或默认入口（新生态）。
   * Supervisor 侧的 per-spawn 覆盖已存在（ADR-0010 决策 8），此前编排层透不过来。
   */
  spawn(spec: { manifest: LoadedManifest; pluginPath: string; cellEntry?: string }): ManagedCell;
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
  /** 承接层入口（缺省 = 工厂自己的默认入口）。 */
  cellEntry?: string;
}

export interface HotSwapRequest {
  /** 新版本 manifest 原始 JSON（五步校验在此执行）。 */
  rawManifest: unknown;
  pluginPath: string;
  /** 承接层入口（缺省 = 工厂自己的默认入口）。 */
  cellEntry?: string;
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
    const cell = this.deps.factory.spawn({
      manifest: req.manifest,
      pluginPath: req.pluginPath,
      cellEntry: req.cellEntry,
    });
    const binding: ScopeBinding = { manifest: req.manifest, cell, state: null };
    this.bindings.set(key, binding);
    return binding;
  }

  current(scope: Scope): ScopeBinding | null {
    return this.bindings.get(scopeKey(scope)) ?? null;
  }

  /**
   * 热装配升级：五步校验 → 新 Cell → 迁移钩（如有）→ 原子换绑。
   * 失败 = 新 Cell 丢弃、旧绑定原样（回退，V5）。
   *
   * **旧 Cell 的收束时机是规则不是注释（切片⑤ §3.3 第 5 步）**：`RunManifest.executor` 在
   * `scheduler.start` 时逐 run 捕获（换绑不改已在途 run 的调用目标），所以本编排层**绝不**在
   * 换绑时 drain 旧舱——那会打断仍在使用它的 run。旧舱由调用方在其 run 终态后 dispose；
   * 若有人在在途 run 期间抢先 drain，后果是可见拒绝（新调用落成 `SCHED/BACKPRESSURE`）而不是悄悄打死。
   */
  async hotSwap(scope: Scope, req: HotSwapRequest): Promise<{ record: AssemblyRecordedPayload }> {
    const key = scopeKey(scope);
    const current = this.bindings.get(key);
    // 五步校验（含升级场景的 migration.from 匹配已装版本）
    const manifest = this.deps.assembler.assemble(req.rawManifest, current?.manifest.meta.version);
    const newCell = this.deps.factory.spawn({
      manifest,
      pluginPath: req.pluginPath,
      cellEntry: req.cellEntry,
    });
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
