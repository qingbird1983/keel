/**
 * 受治理 Workspace（ADR-0018）——写文件的唯一“黄路径”。
 *
 * 为什么写操作在宿主：只有执行写入的一方能给出可信收据。Cell 自报“我创建了文件”无法防止
 * 声明与真实路径漂移；宿主用 `open(..., "wx")` 独占创建、从实际文件句柄读 identity，再把
 * 收据写进账本，内置 `fs.remove` 只认这张收据。
 *
 * 路径规则（fail-closed）：
 * - 必须是绝对路径；`path.resolve` 归一后必须命中本 Run `fs.write.allow`（大小写按平台归一）；
 * - 父目录 `realpath` 后再核一次 allow，拒绝符号链接逃逸、`..` 越界；
 * - 只写普通文件；目标本身是符号链接/目录/设备 → 拒绝；
 * - create = 独占（目标已存在即 `WORKSPACE/EXISTS`）；overwrite = 显式，且不享受内置删除。
 *
 * 残余窗口（如实登记）：identity 复核与 unlink 之间不是原子的（Node 无 `openat`）；
 * create 成功与收据落账之间若进程猝死，可能留下无收据文件（不会被内置补偿误删）。
 */

import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { globMatch, KeelError } from "@keel/core";
import type { EffectIdentity, EffectReceipt, WorkspaceMode } from "@keel/runtime-context";
import type { DeclaredEffectMeta } from "./effects.js";
import type { RunPermissionView } from "./builtins.js";

export interface WorkspaceWriteInput {
  effect: DeclaredEffectMeta;
  mode: WorkspaceMode;
  path: string;
  content: string;
}

export interface WorkspaceWriteResult {
  receipt: EffectReceipt;
  bytes: number;
}

export class Workspace {
  private readonly permissions: RunPermissionView[];
  private readonly now: () => number;

  constructor(opts: { permissions: RunPermissionView[]; now?: () => number }) {
    this.permissions = opts.permissions;
    this.now = opts.now ?? (() => Date.now());
  }

  async write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    const requested = input.path;
    if (
      typeof requested !== "string" ||
      requested.length === 0 ||
      requested.includes("\0") ||
      !path.isAbsolute(requested)
    ) {
      throw new KeelError("WORKSPACE/PATH", "workspace path must be an absolute path", {
        path: requested,
      });
    }
    const resolved = path.resolve(requested);
    const lexical = resourceOf(resolved);
    if (!this.allowed(lexical)) {
      throw new KeelError("AUTH/DENIED", `workspace path not allowed: ${lexical}`, {
        cap: "fs.write",
        path: resolved,
      });
    }

    const parent = path.dirname(resolved);
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch (err) {
      throw new KeelError("WORKSPACE/IO", "workspace parent directory is not accessible", {
        path: parent,
        cause: messageOf(err),
      });
    }
    const target = path.join(realParent, path.basename(resolved)).replace(/\\/g, "/");
    const realResource = resourceOf(target);
    if (!this.allowed(realResource)) {
      throw new KeelError("WORKSPACE/PATH", "resolved path escapes the allowed workspace", {
        path: target,
        resource: realResource,
      });
    }

    const before = await this.inspect(target);
    if (before.exists) {
      if (before.symlink) {
        throw new KeelError("WORKSPACE/PATH", "refusing to write through a symbolic link", {
          path: target,
        });
      }
      if (!before.file) {
        throw new KeelError("WORKSPACE/PATH", "workspace target is not a regular file", {
          path: target,
        });
      }
      if (input.mode === "create") {
        throw new KeelError("WORKSPACE/EXISTS", "workspace target already exists", {
          path: target,
        });
      }
    }

    if (input.mode === "create") {
      return this.create(input, target, before.exists);
    }
    return this.overwrite(input, target, before);
  }

  /** 收据落账失败时的尽力回滚：只删“本次创建且身份仍匹配”的文件。 */
  async rollback(receipt: EffectReceipt): Promise<boolean> {
    if (!receipt.created || !receipt.identity) return false;
    try {
      if (!(await identityMatches(receipt.target, receipt.identity))) return false;
      await unlink(receipt.target);
      return true;
    } catch {
      return false;
    }
  }

  private async create(
    input: WorkspaceWriteInput,
    target: string,
    existed: boolean,
  ): Promise<WorkspaceWriteResult> {
    if (existed) {
      throw new KeelError("WORKSPACE/EXISTS", "workspace target already exists", {
        path: target,
      });
    }
    let handle;
    try {
      handle = await open(target, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new KeelError("WORKSPACE/EXISTS", "workspace target already exists", {
          path: target,
        });
      }
      throw new KeelError("WORKSPACE/IO", "workspace open failed", {
        path: target,
        cause: messageOf(err),
      });
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    try {
      await handle.writeFile(input.content, "utf8");
      const st = await handle.stat();
      const identity = identityOf(st, input.content);
      const receipt: EffectReceipt = {
        opId: input.effect.effectId,
        kind: input.effect.kind,
        mode: "create",
        target,
        workspaceRoot: deriveWorkspaceRoot(this.permissions),
        existed: false,
        created: true,
        overwritten: false,
        identity,
        timestamp: this.now(),
      };
      return { receipt, bytes };
    } catch (err) {
      await handle.close().catch(() => undefined);
      const cleaned = await unlink(target).then(
        () => true,
        () => false,
      );
      throw new KeelError("WORKSPACE/IO", "workspace write failed", {
        path: target,
        cause: messageOf(err),
        cleaned,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async overwrite(
    input: WorkspaceWriteInput,
    target: string,
    before: { exists: boolean; size?: number; mtimeMs?: number },
  ): Promise<WorkspaceWriteResult> {
    const bytes = Buffer.byteLength(input.content, "utf8");
    let handle;
    try {
      handle = await open(target, "w", 0o600);
      await handle.writeFile(input.content, "utf8");
      const st = await handle.stat();
      const receipt: EffectReceipt = {
        opId: input.effect.effectId,
        kind: input.effect.kind,
        mode: "overwrite",
        target,
        workspaceRoot: deriveWorkspaceRoot(this.permissions),
        existed: before.exists,
        created: false,
        overwritten: before.exists,
        identity: identityOf(st, input.content),
        ...(before.exists
          ? { before: { size: before.size ?? null, mtimeMs: before.mtimeMs ?? null } }
          : {}),
        timestamp: this.now(),
      };
      return { receipt, bytes };
    } catch (err) {
      // 覆盖写无法恢复旧内容：不假装可逆，错误里带上旧文件摘要与“未清理”标记
      throw new KeelError("WORKSPACE/IO", "workspace overwrite failed", {
        path: target,
        cause: messageOf(err),
        before: before.exists ? { size: before.size, mtimeMs: before.mtimeMs } : null,
        cleaned: false,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async inspect(target: string): Promise<{
    exists: boolean;
    file: boolean;
    symlink: boolean;
    size?: number;
    mtimeMs?: number;
  }> {
    try {
      const st = await lstat(target);
      return {
        exists: true,
        file: st.isFile(),
        symlink: st.isSymbolicLink(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, file: false, symlink: false };
      }
      throw new KeelError("WORKSPACE/IO", "workspace stat failed", {
        path: target,
        cause: messageOf(err),
      });
    }
  }

  private allowed(resource: string): boolean {
    const allow = this.permissions
      .filter((p) => p.cap === "fs.write")
      .flatMap((p) => p.allow ?? []);
    return allow.some((pattern) => matchPath(pattern, resource));
  }
}

/** 从 allow 模式推导唯一工作区根（`fs:<root>/**`）；不唯一则不猜。 */
export function deriveWorkspaceRoot(permissions: RunPermissionView[]): string | null {
  const roots = new Set<string>();
  for (const p of permissions) {
    if (p.cap !== "fs.write") continue;
    for (const pattern of p.allow ?? []) {
      if (!pattern.startsWith("fs:")) continue;
      const raw = pattern.slice(3);
      const star = raw.indexOf("*");
      const root = (star >= 0 ? raw.slice(0, star) : raw).replace(/\/+$/, "");
      if (root) roots.add(root);
    }
  }
  return roots.size === 1 ? [...roots][0] : null;
}

/** 文件系统路径 → 授权资源字符串（统一正斜杠 + fs: 前缀）。 */
export function resourceOf(target: string): string {
  return `fs:${target.replace(/\\/g, "/")}`;
}

/** Windows 文件系统大小写不敏感：匹配前统一小写（模式与值一起归一）。 */
export function matchPath(pattern: string, resource: string): boolean {
  if (process.platform !== "win32") return globMatch(pattern, resource);
  return globMatch(pattern.toLowerCase(), resource.toLowerCase());
}

/** 按收据核对目标身份：存在、普通文件、dev/ino/size/mtime/sha256 全部一致。 */
export async function identityMatches(target: string, identity: EffectIdentity): Promise<boolean> {
  let st;
  try {
    st = await lstat(target);
  } catch {
    return false;
  }
  if (!st.isFile() || st.isSymbolicLink()) return false;
  if (String(st.dev) !== identity.dev || String(st.ino) !== identity.ino) return false;
  if (st.size !== identity.size || st.mtimeMs !== identity.mtimeMs) return false;
  try {
    const buf = await readFile(target);
    return sha256(buf) === identity.sha256;
  } catch {
    return false;
  }
}

function identityOf(
  st: { dev: number; ino: number; size: number; mtimeMs: number },
  content: string,
): EffectIdentity {
  return {
    dev: String(st.dev),
    ino: String(st.ino),
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256: sha256(Buffer.from(content, "utf8")),
  };
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
