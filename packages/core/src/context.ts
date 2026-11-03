/**
 * 兼容门面（ADR-0017）——新代码请直接使用 `ToolCatalog` 与 `PageStore`。
 *
 * `ContextManager` 只为既有调用方保留：它继承 `ToolCatalog`（因此可赋给调度器/通道服务），
 * 并把换页方法转发给内部 `PageStore`。不在这里增加任何新行为。
 *
 * @deprecated 使用 ToolCatalog（工具目录）+ PageStore（换页）。
 */

import type { RunRef, Scope, ToolSchemaChangedPayload } from "./events.js";
import { PageStore } from "./page-store.js";
import { ToolCatalog, type ToolEntry } from "./tool-catalog.js";

export class ContextManager extends ToolCatalog {
  private readonly pages = new PageStore();

  pageOut(ref: RunRef, pageId: string, state?: unknown): { pageId: string; version: number } {
    return this.pages.pageOut(ref, pageId, state);
  }

  pageIn(ref: RunRef, pageId: string): { pageId: string; version: number; state: unknown } {
    return this.pages.pageIn(ref, pageId);
  }

  pageVersion(ref: RunRef, pageId: string): number {
    return this.pages.pageVersion(ref, pageId);
  }
}

/** 编译期保证门面仍覆盖旧接口（不导出，只做类型断言）。 */
type _Compat = {
  alloc(scope: Scope): void;
  registerTool(scope: Scope, entry: ToolEntry): void;
  discover(ref: RunRef): ToolEntry[];
  consumeSchemaChanges(ref: RunRef): ToolSchemaChangedPayload[];
};
type _CompatCovered = ContextManager extends _Compat ? true : never;
const _compatCovered: _CompatCovered = true;
void _compatCovered;
