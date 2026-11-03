/**
 * 内置补偿注册表（切片③，ADR-0016）——把 80% 的常见撤销动作从插件代码里拿走。
 *
 * 执行位置 = **宿主**：builtin 不 spawn 补偿 Cell，也不需要插件导出 compensations。
 * 首批只有 `fs.remove`（删除本次正向操作创建的文件）与内部 `record-only`（由补偿执行器
 * 直闭，不走本表）。网络请求没有通用逆操作——用 record-only 或插件自定义补偿，不在此处
 * 发明“万能撤销”。
 *
 * 安全边界：`fs.remove` 必须按本 run 的 `ASSEMBLY_RECORDED.permissions` 复核
 * `fs.write.allow`；没有基线或路径不匹配一律拒绝（fail-closed）。builtin 是宿主能力，
 * 不是沙箱；它只执行闭集内的内建动作。
 */

import { unlink } from "node:fs/promises";
import path from "node:path";
import { type RunRef } from "@keel/core";
import { identityMatches, matchPath, resourceOf } from "./workspace.js";
import type { EffectProjectionEntry, ToolResultLike } from "./compensator.js";

/** 装配基线里的权限视图（来自 ASSEMBLY_RECORDED.permissions）。 */
export interface RunPermissionView {
  cap: string;
  allow?: string[];
}

export interface BuiltinActionContext {
  ref: RunRef;
  effect: EffectProjectionEntry;
  permissions: RunPermissionView[];
}

export interface BuiltinAction {
  ref: string;
  exec(ctx: BuiltinActionContext): Promise<ToolResultLike>;
}

/** 闭集：装配器据此拒绝未知内建（未知 = 装配失败，不等到运行期才炸）。 */
export const BUILTIN_REFS: ReadonlySet<string> = new Set(["fs.remove", "record-only"]);

/** 仅 record-only 类可使用的内部引用；由补偿执行器直闭。 */
export const RECORD_ONLY_REF = "record-only";

function failed(
  code: string,
  message: string,
  durationMs: number,
  detail?: unknown,
): ToolResultLike {
  return {
    status: "error",
    error: { code, message, ...(detail !== undefined ? { detail } : {}) },
    durationMs,
  };
}

function targetPath(effect: EffectProjectionEntry): string | null {
  const t = effect.targetSummary;
  const raw = typeof t === "string" ? t : (t as { path?: unknown } | null)?.path;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * fs.remove：删除本次正向操作**确实创建**的文件（ADR-0018）。
 *
 * - 只认收据：`receipt.created === true` 且目标路径 = 收据目标；无收据不删；
 * - 删除前重新核对 identity（dev/ino/size/mtime/sha256）；被替换/修改 → 拒绝并升级；
 * - 容忍目标不存在（T06）：已经不在 = 成功（无需再删）；
 * - 只删单文件（不递归）；符号链接/目录/设备文件一律拒绝；
 * - 覆盖写不要用它——`created:false` 会被拒绝，旧内容本就不可恢复。
 */
export const FS_REMOVE: BuiltinAction = {
  ref: "fs.remove",
  async exec({ effect, permissions }) {
    const t0 = Date.now();
    const receipt = effect.receipt;
    if (!receipt || receipt.created !== true) {
      return failed(
        "COMPENSATION/UNKNOWN",
        "fs.remove requires a receipt proving this run created the file",
        Date.now() - t0,
        { reason: "NO-RECEIPT", path: targetPath(effect) },
      );
    }
    const target = receipt.target;
    if (!path.isAbsolute(target)) {
      return failed(
        "COMPENSATION/UNKNOWN",
        "fs.remove receipt target must be absolute",
        Date.now() - t0,
        {
          path: target,
        },
      );
    }
    const resource = resourceOf(target);
    const allow = permissions.filter((p) => p.cap === "fs.write").flatMap((p) => p.allow ?? []);
    if (!allow.some((pattern) => matchPath(pattern, resource))) {
      return failed("AUTH/DENIED", `compensation path not allowed: ${resource}`, Date.now() - t0, {
        cap: "fs.write",
        path: target,
      });
    }
    if (!receipt.identity || !(await identityMatches(target, receipt.identity))) {
      return failed(
        "COMPENSATION/UNKNOWN",
        "fs.remove identity check failed; refusing to delete",
        Date.now() - t0,
        { reason: "IDENTITY-MISMATCH", path: target },
      );
    }
    try {
      await unlink(target);
      return { status: "ok", result: { removed: target }, durationMs: Date.now() - t0 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          status: "ok",
          result: { removed: false, reason: "already-absent" },
          durationMs: Date.now() - t0,
        };
      }
      return failed(
        "COMPENSATION/UNKNOWN",
        err instanceof Error ? err.message : String(err),
        Date.now() - t0,
        { path: target },
      );
    }
  },
};

/** 默认内建表；测试可注入同形替身。 */
export const DEFAULT_BUILTINS: ReadonlyMap<string, BuiltinAction> = new Map([
  [FS_REMOVE.ref, FS_REMOVE],
]);
