/**
 * 上下文管理器 —— 契约 §4.6（MVP 范围：scope 分区 + tool.discover）。
 *
 * - 一切接口以 scope/runRef 为首参，不存在无作用域的全局查询接口（V1 / I5）。
 * - 工具 schema 变更 = 挂起变更日志按 scope 追加；调度器在轮边界按 run 游标取走并写入账本
 *   （TOOL_SCHEMA_CHANGED 仅传播到受影响 scope；affectedScope=null 表示全局广播）。
 * - context.alloc 幂等（同 scope 返回既有分区）；CTX/SCOPE-EXISTS 预留给与既有分区冲突的
 *   创建语义，MVP 幂等路径不触达。
 * - 换页原语（context.page.out/in）随上下文页存储后端在 Phase 1 后续切片落地（契约 §4.6 注记）。
 */

import { KeelError } from "./errors.js";
import { scopeKey, type RunRef, type Scope, type ToolSchemaChangedPayload } from "./events.js";

/** scope 内可见工具表条目（tool.discover 返回面）。 */
export interface ToolEntry {
  name: string;
  schemaVersion: number;
  schema: unknown;
}

interface Partition {
  tools: Map<string, ToolEntry>;
  /** 挂起变更日志（只追加）；各 run 按游标消费，同 scope 多 run 不丢事件。 */
  changes: ToolSchemaChangedPayload[];
}

export class ContextManager {
  private readonly partitions = new Map<string, Partition>();
  /** runId → 已消费的变更日志下标（同 scope 多 run 各自独立游标）。 */
  private readonly cursors = new Map<string, number>();

  /** 创建 scope 私有分区（工具表视图）；同 scope 幂等（契约 context.alloc）。 */
  alloc(scope: Scope): void {
    const key = scopeKey(scope);
    if (!this.partitions.has(key)) this.partitions.set(key, { tools: new Map(), changes: [] });
  }

  hasScope(scope: Scope): boolean {
    return this.partitions.has(scopeKey(scope));
  }

  /** 注册/更新工具（仅本 scope 可见）；写挂起变更，不改其他 scope 的任何状态。 */
  registerTool(scope: Scope, entry: ToolEntry): void {
    const p = this.partition(scope);
    const old = p.tools.get(entry.name);
    p.tools.set(entry.name, entry);
    p.changes.push({
      tool: entry.name,
      oldSchemaVersion: old?.schemaVersion ?? 0,
      newSchemaVersion: entry.schemaVersion,
      affectedScope: { ...scope },
    });
  }

  /** 移除工具（newSchemaVersion=0 表示下线）。 */
  removeTool(scope: Scope, name: string): void {
    const p = this.partition(scope);
    const old = p.tools.get(name);
    if (!old) return;
    p.tools.delete(name);
    p.changes.push({
      tool: name,
      oldSchemaVersion: old.schemaVersion,
      newSchemaVersion: 0,
      affectedScope: { ...scope },
    });
  }

  /** 本 scope 可见工具表（契约 tool.discover：无全局模式；稳定排序保证缓存命中稳定）。 */
  discover(ref: RunRef): ToolEntry[] {
    const p = this.partition({ agentId: ref.agentId, sessionId: ref.sessionId });
    return [...p.tools.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** 调度器轮边界取走本 run 的挂起变更（含全局广播），写 TOOL_SCHEMA_CHANGED 入账本。 */
  consumeSchemaChanges(ref: RunRef): ToolSchemaChangedPayload[] {
    const p = this.partition({ agentId: ref.agentId, sessionId: ref.sessionId });
    const from = this.cursors.get(ref.runId) ?? 0;
    const out = p.changes.slice(from);
    this.cursors.set(ref.runId, p.changes.length);
    return out;
  }

  private partition(scope: Scope): Partition {
    const p = this.partitions.get(scopeKey(scope));
    if (!p) {
      throw new KeelError("CTX/SCOPE-UNKNOWN", "scope partition not allocated", { scope });
    }
    return p;
  }
}
