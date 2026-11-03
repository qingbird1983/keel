/**
 * 快照存储（D3；切片⑤把它从"宿主内存"改成**落盘**，B7② 的主张才有地面）。
 *
 * - 账本仍只存 `STATE_SNAPSHOT_REF` 元数据（契约 §4.5 / ADR-0004：一致点锚是 CHECKPOINT，
 *   快照是挂载用的内容，归宿主）；**内容在这里**。
 * - ref 约定一字未改：`<agentId>|<sessionId>/snap-<version>`（账本里已存的值必须继续读得回）。
 *   ref 是**标识符不是路径**——竖线在 Windows 是非法文件名字符，所以路径另行派生。
 * - 写序：先内容落盘成功、后由调用方写 `STATE_SNAPSHOT_REF`（`apps/keel/src/runtime.ts` 的
 *   checkpoint 缝就是这个顺序）。于是"账本有 ref 而内容不在"只可能来自外部破坏（目录被删），
 *   不会由本存储自己制造。
 * - 冷启动版本号：新实例扫本 scope 目录取最大版本（`lastCheckpoint` 的冷扫描同一姿态）——
 *   不扫就等于允许新内容覆盖旧版本号，那会把历史快照毁掉。
 * - 内容必须 JSON 可序列化；不可序列化或写盘失败 = **抛错**（不静默跳过这次快照，
 *   也不返回 null 让调用方以为"这舱没状态"）。可见失败的落点在宿主（runtime 的 snapshotFailures）。
 */

import { mkdir, open, readdir, rename, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { scopeKey, type Scope } from "@keel/core";

export interface SnapshotEntry {
  state: unknown;
  version: number;
  round: number;
}

export interface SnapshotStoreOptions {
  /** 快照根目录（切片⑤ §7 第 2 项：`--snapshots`，缺省由账本根派生同级 `<name>-snapshots`）。 */
  rootDir: string;
}

/** `<agentId>|<sessionId>/snap-<version>` → 两段（ref 形状非法 = 不是本存储的 ref）。 */
function splitRef(ref: string): { key: string; version: number } | null {
  const [key, file] = ref.split("/");
  if (!key || !file) return null;
  const m = /^snap-(\d+)$/.exec(file);
  return m ? { key, version: Number(m[1]) } : null;
}

/**
 * 序列化守卫：`JSON.stringify` 对**函数 / symbol / bigint 不抛错，而是把它们悄悄丢掉**
 * （键整个消失），那等于把插件状态变形后存盘——恢复时挂回去的是另一个对象。
 * 所以这里显式拒绝这类内容（循环引用由 stringify 自己抛）。
 * 注：`undefined` 值仍按 JSON 语义 = 键不存在（不是变形，是 JSON 的表达力边界）；
 * 整个 state 为 undefined 走上面的"无状态舱"路径。
 */
function guardUnrepresentable(key: string, value: unknown): unknown {
  const t = typeof value;
  if (t === "function" || t === "symbol" || t === "bigint") {
    throw new TypeError(
      `snapshot content is not JSON-representable at "${key || "(root)"}" (${t}) — ` +
        `JSON.stringify would silently drop it, so the mounted state would not be what the cell wrote`,
    );
  }
  return value;
}

export class SnapshotStore {
  private readonly rootDir: string;
  /** scopeKey → 最新版本（写入递增；冷实例首次用到该 scope 时扫目录补齐）。 */
  private readonly heads = new Map<string, number>();
  /** 已扫过目录的 scope（避免每次 save 都 readdir）。 */
  private readonly loaded = new Set<string>();

  constructor(opts: SnapshotStoreOptions) {
    this.rootDir = opts.rootDir;
  }

  /**
   * 保存快照并返回 `STATE_SNAPSHOT_REF` 元数据；`state === null`（无状态 Cell）不写、返回 null。
   * 其余一切失败（不可序列化 / 建目录失败 / 写盘失败）都抛——见文件头"可见失败"一条。
   */
  async save(
    scope: Scope,
    round: number,
    state: unknown,
  ): Promise<{ ref: string; version: number } | null> {
    if (state === null || state === undefined) return null;
    const key = scopeKey(scope);
    await this.ensureHead(key);
    const version = (this.heads.get(key) ?? 0) + 1;
    const body = JSON.stringify({ state, version, round }, guardUnrepresentable); // 循环引用/不可表示值在此抛
    const dir = this.scopeDir(scope);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `snap-${version}.json`);
    const tmp = `${target}.tmp`;
    // 原子：先写临时文件并 fsync，再 rename 到位（版本号单调 ⇒ 目标必不存在，不会覆盖历史）
    const fh = await open(tmp, "w");
    try {
      await fh.write(body, null, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
    this.heads.set(key, version);
    return { ref: `${key}/snap-${version}`, version };
  }

  /** 按 ref 取快照；未知 ref（含从未写过与被外部删除）返回 undefined。 */
  async get(ref: string): Promise<SnapshotEntry | undefined> {
    const parts = splitRef(ref);
    if (!parts) return undefined;
    const [agentId, sessionId] = parts.key.split("|");
    if (!agentId || !sessionId) return undefined;
    const file = path.join(this.rootDir, agentId, sessionId, `snap-${parts.version}.json`);
    try {
      const entry = JSON.parse(await readFile(file, "utf8")) as SnapshotEntry;
      return entry;
    } catch {
      return undefined; // ENOENT / 半截文件 / 非法 JSON：读方按"内容不在"处理
    }
  }

  private scopeDir(scope: Scope): string {
    return path.join(this.rootDir, scope.agentId, scope.sessionId);
  }

  /** 冷启动补齐版本号（F6）：扫目录里 `snap-<n>.json` 取最大 n。只扫一次。 */
  private async ensureHead(key: string): Promise<void> {
    if (this.loaded.has(key)) return;
    this.loaded.add(key);
    const [agentId, sessionId] = key.split("|");
    if (!agentId || !sessionId) return;
    let names: string[];
    try {
      names = await readdir(path.join(this.rootDir, agentId, sessionId));
    } catch {
      names = []; // 目录还不存在 = 该 scope 没写过快照
    }
    let max = 0;
    for (const n of names) {
      const m = /^snap-(\d+)\.json$/.exec(n);
      if (m) max = Math.max(max, Number(m[1]));
    }
    if (max > 0) this.heads.set(key, max);
  }

  /** 清掉一个 scope 的落盘内容（仅供测试与人工排障用；生产路径不调）。 */
  async dropScope(scope: Scope): Promise<void> {
    await rm(this.scopeDir(scope), { recursive: true, force: true });
    this.heads.delete(scopeKey(scope));
    this.loaded.delete(scopeKey(scope));
  }
}
