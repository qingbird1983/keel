/**
 * 换页原语（契约 §4.6 注记，切片④；ADR-0017 从 ContextManager 拆出）。
 *
 * per-run 页注册表、内存后端；版本单调递增；页版本由调用方经 CONTEXT_PAGED 事件入本 run 账本。
 * 物理页存储后端登记 backlog。
 */

import { KeelError } from "./errors.js";
import type { RunRef } from "./events.js";

/** 页记录：内存后端，版本单调；pagedOut = 工作集外。 */
interface PageRecord {
  state: unknown;
  version: number;
  pagedOut: boolean;
}

export class PageStore {
  /** runId → (pageId → 页记录)。 */
  private readonly pages = new Map<string, Map<string, PageRecord>>();

  /**
   * 移出页：登记/更新内容并标记工作集外，版本 +1（首移出 = 版本 1）。
   * 返回当前版本（调用方写 CONTEXT_PAGED{direction:"out", version} 入账本）。
   */
  pageOut(ref: RunRef, pageId: string, state?: unknown): { pageId: string; version: number } {
    const m = this.pageMap(ref.runId);
    const old = m.get(pageId);
    const rec: PageRecord = {
      state: state ?? old?.state ?? null,
      version: (old?.version ?? 0) + 1,
      pagedOut: true,
    };
    m.set(pageId, rec);
    return { pageId, version: rec.version };
  }

  /**
   * 移回页：仅对处于工作集外的页有效；页不存在或已在工作集内 → CTX/PAGE-MISSING。
   * 返回内容与版本（调用方写 CONTEXT_PAGED{direction:"in", version} 入账本）。
   */
  pageIn(ref: RunRef, pageId: string): { pageId: string; version: number; state: unknown } {
    const rec = this.pages.get(ref.runId)?.get(pageId);
    if (!rec || !rec.pagedOut) {
      throw new KeelError("CTX/PAGE-MISSING", "no paged-out page under this id", {
        runId: ref.runId,
        pageId,
      });
    }
    rec.pagedOut = false;
    return { pageId, version: rec.version, state: rec.state };
  }

  /** 当前页版本（诊断用）；页不存在 → CTX/PAGE-MISSING。 */
  pageVersion(ref: RunRef, pageId: string): number {
    const rec = this.pages.get(ref.runId)?.get(pageId);
    if (!rec) {
      throw new KeelError("CTX/PAGE-MISSING", "page not found", { runId: ref.runId, pageId });
    }
    return rec.version;
  }

  private pageMap(runId: string): Map<string, PageRecord> {
    let m = this.pages.get(runId);
    if (!m) {
      m = new Map();
      this.pages.set(runId, m);
    }
    return m;
  }
}
