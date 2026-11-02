import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Authorizer, type AuthPolicyInput } from "../src/authorizer.js";
import { Ledger } from "../src/ledger.js";

let dir: string;
const ledgers: Ledger[] = [];
const ref = { agentId: "agent-1", sessionId: "sess-1", runId: "run-1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keel-auth-"));
});
afterEach(async () => {
  await Promise.allSettled(ledgers.map((l) => l.close()));
  ledgers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

function harness(policy: AuthPolicyInput) {
  const ledger = new Ledger({ rootDir: dir, now: () => 0 });
  ledgers.push(ledger);
  return { ledger, auth: new Authorizer(policy, ledger) };
}

describe("Authorizer（fail-closed）", () => {
  it("空策略 = 默认拒绝，且 AUTH_DENIED 必留痕（契约 §4.2 / 验收 A7）", async () => {
    const { ledger, auth } = harness({ version: "t1", allow: [] });
    const d = await auth.check(ref, "cell-1", "net.fetch", "https://example.com");
    expect(d.allowed).toBe(false);
    const page = await ledger.read({ runId: "run-1" });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      type: "AUTH_DENIED",
      payload: {
        subject: "cell-1",
        action: "net.fetch",
        resource: "https://example.com",
        policyVersion: "t1",
      },
    });
  });

  it("精确规则命中 = 允许，且允许不留事件", async () => {
    const { ledger, auth } = harness({
      version: "t2",
      allow: [{ subject: "cell-1", action: "net.fetch", resource: "https://api.example.com" }],
    });
    const d = await auth.check(ref, "cell-1", "net.fetch", "https://api.example.com");
    expect(d.allowed).toBe(true);
    // 允许路径零事件：run 目录从未被写入（读取按寻址失败）
    await expect(ledger.read({ runId: "run-1" })).rejects.toMatchObject({
      code: "LEDGER/CURSOR-INVALID",
    });
  });

  it("通配符：`*` 全匹配主体/动作", async () => {
    const { auth } = harness({
      version: "t3",
      allow: [{ subject: "*", action: "*", resource: "fs:/workspace/*" }],
    });
    expect((await auth.check(ref, "any", "fs.read", "fs:/workspace/a.txt")).allowed).toBe(true);
    expect((await auth.check(ref, "any", "fs.read", "fs:/etc/passwd")).allowed).toBe(false);
  });

  it("资源 glob：`**` 跨段、`*` 段内不跨段", async () => {
    const { auth } = harness({
      version: "t4",
      allow: [{ subject: "*", action: "fs.read", resource: "fs:/data/**/*.csv" }],
    });
    expect((await auth.check(ref, "c", "fs.read", "fs:/data/a/b/x.csv")).allowed).toBe(true);
    expect((await auth.check(ref, "c", "fs.read", "fs:/data/x.csv")).allowed).toBe(true);
    expect((await auth.check(ref, "c", "fs.read", "fs:/data/a/b/x.json")).allowed).toBe(false);
  });

  it("策略版本可读（auth.policy.get 语义）", () => {
    const { auth } = harness({ version: "v9", allow: [] });
    expect(auth.version).toBe("v9");
  });
});
