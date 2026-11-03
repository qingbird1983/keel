/**
 * B7②（07 稿 §3.2）：**跨宿主进程**的快照恢复。
 *
 * 时序假设（先写下再断言，P-006）：
 * - 宿主 A（`keel run` 子进程）在第 3 次 tick 时因插件未捕获异常而崩溃；崩溃前第 1、2 轮各自
 *   在轮尾收束，所以账本里已经有两条 CHECKPOINT + 两条 STATE_SNAPSHOT_REF（最后一条 = ticks:2）。
 * - 宿主 A **自己退出**（不需要测试杀进程），于是后面的 `keel recover` 是另一个进程 = 另一个宿主。
 * - 今天的实现把快照放在宿主内存（07 稿 F4）：新进程的存储是空的 → `RECOVER/SNAPSHOT-MISSING`。
 *   第②条因此是先于实现存在的红；第①条是前提核对（今天也过，用来证明红不是"根本没跑起来"）；
 *   第③条不是红，它是"内容确实不在时失败要看得见"的防回归钉。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(".");
const bin = path.join(repoRoot, "apps", "keel", "dist", "main.js");
const plugin = "tests/fixtures/stateful-boom-plugin.mjs";
/** 3 次崩溃 + 6 轮上限：保证崩溃前至少收过两次尾。 */
const ROUNDS = "6";

const manifestRaw = {
  kind: "capability",
  meta: {
    name: "stateful-boom-demo",
    version: "1.0.0",
    title: "S",
    description: "slice-5 B7-2 cross-host snapshot recovery",
  },
  permissions: [{ cap: "tool.provide" }],
  resources: { toolCallTimeoutMs: 10_000 },
  compensation: { templates: [] },
  compat: { keelContract: "^1.0" },
};

let tmp: string;
let manifestFile: string;
let dataDir: string;
let snapshotDir: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "keel-b72-"));
  // 账本根里只准装 <agentId>/<sessionId>/<runId>：cmd-recover 的 findRunRef 按那三层扫目录，
  // 混进一个散文件会让它对一个文件路径 readdirSync 抛 ENOTDIR。所以 manifest 放在账本根之外。
  dataDir = path.join(tmp, "ledger");
  snapshotDir = path.join(tmp, "snapshots");
  manifestFile = path.join(tmp, "manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifestRaw, null, 2)}\n`, "utf8");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** 宿主 A：真子进程跑一次会崩溃的 run；退出码非 0（终态 failed）是这条用例的前提而不是意外。 */
async function runHostA(): Promise<{ code: number | null; out: string }> {
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        bin,
        "run",
        "--manifest",
        manifestFile,
        "--plugin",
        plugin,
        "--tool",
        "tick",
        "--rounds",
        ROUNDS,
        "--data-dir",
        dataDir,
        "--snapshots",
        snapshotDir,
      ],
      { cwd: repoRoot },
    );
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
    });
    child.stderr.on("data", (b) => {
      out += b.toString();
    });
    // Windows 上 exit 滞后 close（P-001）：只等 exit，输出按块聚合已足够判定
    child.on("exit", (code) => resolve({ code, out }));
  });
}

/** 账本原文（宿主 A 的进程已经不在了，这里读的是盘上的文件）。 */
function ledgerLines(): string[] {
  const out: string[] = [];
  // 深度按 dataDir=0 起算：keel-cli(1) / sess-<runId>(2) / <runId>(3) 里才是 seg-*.jsonl
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (p.endsWith(".jsonl")) out.push(...readFileSync(p, "utf8").split("\n"));
      else walk(p, depth + 1);
    }
  };
  walk(dataDir, 0);
  return out.filter((l) => l.trim() !== "");
}

function findRunId(): string {
  for (const line of ledgerLines()) {
    const runId = (JSON.parse(line) as { runId: string }).runId;
    if (runId) return runId;
  }
  return "";
}

function recover(): { status: number; out: string } {
  const args = [
    "recover",
    "--data-dir",
    dataDir,
    "--snapshots",
    snapshotDir,
    "--run",
    findRunId(),
    "--plugin",
    plugin,
    "--manifest",
    manifestFile,
    "--tool",
    "get-state",
  ];
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 90_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("B7②：宿主重启后凭持久化快照恢复（真子进程）", () => {
  it("崩溃的 run 留下了快照引用（前提核对：账本上真有，不是测试自己塞的）", async () => {
    const a = await runHostA();
    expect(a.code).not.toBe(0); // 终态 failed（插件未捕获异常 → CELL/CRASH）
    expect(a.out).toContain("status: failed");
    const refs = ledgerLines().filter((l) => l.includes("STATE_SNAPSHOT_REF"));
    // round 1 与 round 2 各收过一次尾 → 至少两条快照引用
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(ledgerLines().some((l) => l.includes('"RUN_FAILED"'))).toBe(true);
    expect(findRunId()).not.toBe("");
  }, 180_000);

  it("新宿主进程 recover：把最近快照挂回新舱（今天红在 SNAPSHOT-MISSING）", async () => {
    await runHostA();
    const r = recover();
    // 主张：恢复成功（退出 0）、账本有 RUN_RECOVERED、挂上的状态就是崩溃前最后一次收束的 ticks
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("SNAPSHOT-MISSING");
    expect(r.out).toContain("RUN_RECOVERED");
    expect(r.out).toContain('mounted state: {"ticks":2}');
    // 快照内容确实在盘上（不是靠内存活下来的）
    expect(existsSync(snapshotDir)).toBe(true);
  }, 180_000);

  it("快照目录被外部清掉时失败要指名 ref（不静默按「没有快照」续跑）", async () => {
    await runHostA();
    await rm(snapshotDir, { recursive: true, force: true });
    const r = recover();
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("SNAPSHOT-MISSING");
    expect(r.out).toContain("snap-"); // ref 本体在错误里可见（审计员找得到是哪一笔）
  }, 180_000);
});
