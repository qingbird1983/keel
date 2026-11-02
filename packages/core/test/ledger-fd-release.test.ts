/**
 * 段滚动的句柄释放回归测试（铁律 7：先红后修的产物；缺陷原貌 = `rollSegment` 里 close 未 await）。
 *
 * 为什么单独成文件并 mock `node:fs/promises`：`FileHandle.close` 是**实例自有属性**（原型上没有），
 * 想拿到"每一次 close 的发起与完成时刻"只能包装 `open()` 的返回值；mock 只作用于本文件，
 * 不牵动 ledger.test.ts 的其余用例，也不给生产代码加为测试而设的注入面。
 *
 * 断言口径 = 可确定性观察的"awaited 性"：`checkpoint()` 承诺 resolve 时，被滚掉的旧段句柄必须
 * 已真正关闭完。浮空的 close 在此刻必然 done=false。这个缺陷在真实运行里的表现是 Node 24+ 的
 * 硬错误（"A FileHandle object was closed during garbage collection"，本机 Node 26 命中），
 * CI 的 Node 22 只会静默——所以必须有这条与环境无关的断言。
 */

import { mkdtemp, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.js";

interface CloseRecord {
  fd: number;
  done: boolean;
}

/** 每次 close 发起时登记一条；原生 close 完成后置 done（包装点在下方 mock 工厂里）。 */
const closes: CloseRecord[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const openNative = actual.open as unknown as (p: string, flags: string) => Promise<FileHandle>;
  return {
    ...actual,
    open: async (p: string, flags: string) => {
      const handle = await openNative(p, flags);
      const nativeClose = handle.close.bind(handle);
      const rec: CloseRecord = { fd: handle.fd, done: false };
      closes.push(rec);
      handle.close = () =>
        nativeClose().then(() => {
          rec.done = true;
        });
      return handle;
    },
  };
});

const ref = { agentId: "agent-fd", sessionId: "sess-fd", runId: "run-fd" };
const dirs: string[] = [];
const open: Ledger[] = [];

/** 写入实例一律登记：用例中途失败时 afterEach 仍确定性关闭（不留给 GC，见 P-005）。 */
function newLedger(rootDir: string, segMaxBytes: number): Ledger {
  const l = new Ledger({ rootDir, now: () => 0, segMaxBytes });
  open.push(l);
  return l;
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keel-ledger-fd-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((l) => l.close()));
  closes.length = 0;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("Ledger 段滚动的句柄释放（确定性 close）", () => {
  it("滚动旧段：close 完成后 checkpoint 才 resolve；close() 自身不留浮空句柄", async () => {
    const ledger = newLedger(await tempRoot(), 1);
    await ledger.append(ref, "DECISION", {});
    await ledger.checkpoint(ref, 1); // 阈值 1B → 本次 checkpoint 必滚一段

    expect(closes).toHaveLength(1); // 旧段句柄的 close 已发起
    expect(closes[0].done).toBe(true); // 且真正完成 = await 过的直接证据

    await ledger.close();
    expect(closes.every((c) => c.done)).toBe(true); // 当前段亦确定性释放
  });
});
