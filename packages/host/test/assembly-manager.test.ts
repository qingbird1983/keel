import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeelError, type Scope } from "@keel/core";
import { Assembler, type LoadedManifest } from "../src/assembler.js";
import { AssemblyManager, type CellFactory, type ManagedCell } from "../src/assembly-manager.js";

const SCHEMA_PATH = path.resolve("docs/design/phase-1/schema/keel-plugin.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
const scope: Scope = { agentId: "agent-1", sessionId: "sess-1" };

function capability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "capability",
    meta: { name: "plug-a", version: "1.2.0", title: "A", description: "test plugin" },
    permissions: [{ cap: "tool.provide" }],
    resources: { toolCallTimeoutMs: 5_000 },
    compensation: { templates: [] },
    compat: { keelContract: "^1.0" },
    ...overrides,
  };
}

/** 内存 Cell 替身：migrate/dispose 可编程。 */
function fakeCell(over: Partial<ManagedCell> = {}): ManagedCell & {
  migrated: unknown[];
  disposed: boolean;
} {
  const cell = {
    migrated: [] as unknown[],
    disposed: false,
    async migrate(oldState: unknown) {
      cell.migrated.push(oldState);
      return over.migrate ? over.migrate(oldState) : { ...(oldState as object), migrated: true };
    },
    async dispose() {
      cell.disposed = true;
      return over.dispose?.();
    },
  };
  return cell;
}

function rig(cells: ManagedCell[] = []) {
  const factory: CellFactory = {
    spawn: (spec) => {
      const c = cells.shift() ?? fakeCell();
      spawned.push({ manifest: spec.manifest, cell: c as ReturnType<typeof fakeCell> });
      return c;
    },
  };
  const spawned: { manifest: LoadedManifest; cell: ReturnType<typeof fakeCell> }[] = [];
  const manager = new AssemblyManager({
    assembler: new Assembler({ schema, contractVersion: "1.0.0" }),
    factory,
  });
  return { manager, spawned };
}

describe("AssemblyManager：bind / current", () => {
  it("bind 后可取当前绑定；重复 bind 拒绝（CTX/SCOPE-EXISTS）", () => {
    const { manager } = rig();
    manager.bind(scope, { manifest: managerManifest(), pluginPath: "/p/v1.mjs" });
    expect(manager.current(scope)?.manifest.meta.version).toBe("1.2.0");
    expect(() =>
      manager.bind(scope, { manifest: managerManifest(), pluginPath: "/p/v1.mjs" }),
    ).toThrow(expect.objectContaining({ code: "CTX/SCOPE-EXISTS" }));
  });

  it("其他 scope 互不可见（I5）", () => {
    const { manager } = rig();
    manager.bind(scope, { manifest: managerManifest(), pluginPath: "/p/v1.mjs" });
    expect(manager.current({ agentId: "agent-2", sessionId: "sess-1" })).toBeNull();
  });
});

describe("AssemblyManager：hotSwap（V5）", () => {
  it("成功路径：新 Cell → 原子换绑；无 migration = 无状态升级", async () => {
    const { manager } = rig();
    manager.bind(scope, { manifest: managerManifest(), pluginPath: "/p/v1.mjs" });
    const v2 = capability({
      meta: { name: "plug-a", version: "1.3.0", title: "A", description: "d" },
    });
    const { record } = await manager.hotSwap(scope, { rawManifest: v2, pluginPath: "/p/v2.mjs" });
    expect(record.manifest.version).toBe("1.3.0");
    expect(record.replacesVersion).toBe("1.2.0");
    expect(manager.current(scope)?.manifest.meta.version).toBe("1.3.0");
    expect(manager.current(scope)?.state).toBeNull(); // 无 migration：快照不迁移
  });

  it("迁移钩执行：入参 = 旧状态，出参入绑定槽（D3 MVP 内存槽）", async () => {
    const newCell = fakeCell();
    // 第一个 spawn 供 bind 消费，第二个（newCell）供 hotSwap
    const { manager, spawned } = rig([fakeCell(), newCell]);
    manager.bind(scope, { manifest: managerManifest(), pluginPath: "/p/v1.mjs" });
    manager.current(scope)!.state = { counter: 1 };
    const v2 = capability({
      meta: { name: "plug-a", version: "1.3.0", title: "A", description: "d" },
      migration: { from: "^1.2", steps: [{ to: "1.3.0", action: { type: "hook", ref: "m" } }] },
    });
    await manager.hotSwap(scope, { rawManifest: v2, pluginPath: "/p/v2.mjs" });
    expect(newCell.migrated).toEqual([{ counter: 1 }]);
    expect(manager.current(scope)?.state).toEqual({ counter: 1, migrated: true });
    expect(spawned[0].cell.disposed).toBe(false); // 旧 Cell 由调用方在其 run 收束后处置
  });

  it("迁移钩失败 → 新 Cell 丢弃、旧绑定原样（回退，V5）", async () => {
    const newCell = fakeCell({
      migrate: () => {
        throw new Error("hook blew up");
      },
    });
    const { manager, spawned } = rig([fakeCell(), newCell]);
    manager.bind(scope, { manifest: managerManifest(), pluginPath: "/p/v1.mjs" });
    const v2 = capability({
      meta: { name: "plug-a", version: "1.3.0", title: "A", description: "d" },
      migration: { from: "^1.2", steps: [{ to: "1.3.0", action: { type: "hook", ref: "m" } }] },
    });
    await expect(
      manager.hotSwap(scope, { rawManifest: v2, pluginPath: "/p/v2.mjs" }),
    ).rejects.toMatchObject({ code: "SCHED/MANIFEST-INVALID" });
    // 回退主张：新 Cell 已丢弃；旧作用域继续服务
    expect(newCell.disposed).toBe(true);
    expect(manager.current(scope)?.manifest.meta.version).toBe("1.2.0");
    expect(
      spawned.every(
        (s) => s.manifest.meta.version === "1.2.0" || s.manifest.meta.version === "1.3.0",
      ),
    ).toBe(true);
  });

  it("装配校验失败（未 spawn）→ 直接拒绝，无任何 Cell 创建", async () => {
    const { manager, spawned } = rig();
    manager.bind(scope, { manifest: managerManifest(), pluginPath: "/p/v1.mjs" });
    await expect(
      manager.hotSwap(scope, {
        rawManifest: capability({
          meta: { name: "plug-a", version: "bad", title: "A", description: "d" },
        }),
        pluginPath: "/p/v2.mjs",
      }),
    ).rejects.toBeInstanceOf(KeelError);
    expect(spawned).toHaveLength(1); // 只有 bind 时那一个
    expect(manager.current(scope)?.manifest.meta.version).toBe("1.2.0");
  });
});

function managerManifest(): LoadedManifest {
  return new Assembler({ schema, contractVersion: "1.0.0" }).assemble(capability());
}
