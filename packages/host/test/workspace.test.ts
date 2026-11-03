import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeclaredEffectMeta } from "../src/effects.js";
import { deriveWorkspaceRoot, identityMatches, resourceOf, Workspace } from "../src/workspace.js";

let dir: string;
let workspace: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-workspace-"));
  workspace = new Workspace({
    permissions: [{ cap: "fs.write", allow: [`fs:${dir.replace(/\\/g, "/")}/**`] }],
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function effect(effectId = "e-1"): DeclaredEffectMeta {
  return {
    effectId,
    seq: 1,
    kind: "fs.write.done",
    targetSummary: null,
    actionRef: "fs.remove",
    actionType: "builtin",
    settled: false,
  };
}

describe("Workspace（ADR-0018）", () => {
  it("create：独占创建 + 收据 identity；重复 create = WORKSPACE/EXISTS", async () => {
    const target = path.join(dir, "a.txt");
    const r = await workspace.write({
      effect: effect(),
      mode: "create",
      path: target,
      content: "hi",
    });
    expect(await readFile(target, "utf8")).toBe("hi");
    expect(r.receipt).toMatchObject({
      mode: "create",
      created: true,
      existed: false,
      overwritten: false,
      target: target.replace(/\\/g, "/"),
    });
    expect(r.receipt.identity?.sha256).toHaveLength(64);
    await expect(
      workspace.write({ effect: effect(), mode: "create", path: target, content: "again" }),
    ).rejects.toMatchObject({ code: "WORKSPACE/EXISTS" });
    expect(await readFile(target, "utf8")).toBe("hi");
  });

  it("overwrite：收据 created:false / overwritten:true；内容替换", async () => {
    const target = path.join(dir, "b.txt");
    await writeFile(target, "old");
    const r = await workspace.write({
      effect: effect(),
      mode: "overwrite",
      path: target,
      content: "new",
    });
    expect(await readFile(target, "utf8")).toBe("new");
    expect(r.receipt).toMatchObject({
      mode: "overwrite",
      created: false,
      existed: true,
      overwritten: true,
    });
  });

  it("相对路径 / allow 外路径 / .. 逃逸 → 拒绝", async () => {
    await expect(
      workspace.write({ effect: effect(), mode: "create", path: "relative.txt", content: "x" }),
    ).rejects.toMatchObject({ code: "WORKSPACE/PATH" });
    const outside = path.join(dir, "..", "outside.txt");
    await expect(
      workspace.write({ effect: effect(), mode: "create", path: outside, content: "x" }),
    ).rejects.toMatchObject({ code: "AUTH/DENIED" });
    const elsewhere = path.join(tmpdir(), "not-allowed.txt");
    await expect(
      workspace.write({ effect: effect(), mode: "create", path: elsewhere, content: "x" }),
    ).rejects.toMatchObject({ code: "AUTH/DENIED" });
  });

  it("identityMatches：内容被改写后拒绝", async () => {
    const target = path.join(dir, "c.txt");
    const r = await workspace.write({
      effect: effect(),
      mode: "create",
      path: target,
      content: "v1",
    });
    expect(await identityMatches(target, r.receipt.identity!)).toBe(true);
    await writeFile(target, "v2");
    expect(await identityMatches(target, r.receipt.identity!)).toBe(false);
  });

  it("deriveWorkspaceRoot：唯一根可推导；多根/无根不猜", () => {
    expect(deriveWorkspaceRoot([{ cap: "fs.write", allow: ["fs:/w/a/**"] }])).toBe("/w/a");
    expect(
      deriveWorkspaceRoot([{ cap: "fs.write", allow: ["fs:/w/a/**", "fs:/w/b/**"] }]),
    ).toBeNull();
    expect(deriveWorkspaceRoot([{ cap: "fs.read", allow: ["fs:/w/**"] }])).toBeNull();
    expect(resourceOf("C:\\w\\a.txt")).toBe("fs:C:/w/a.txt");
  });
});
