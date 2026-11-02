#!/usr/bin/env node
/**
 * keel CLI —— Phase 1 验收场景执行入口（04 稿 §2 命令面）。
 * 薄壳：只做参数解析与编排调用；每命令的返回值即进程退出码。
 */
import { pathToFileURL } from "node:url";
import { cmdBench } from "./cmd-bench.js";
import { cmdHotswap } from "./cmd-hotswap.js";
import { cmdObserve } from "./cmd-observe.js";
import { cmdRecover } from "./cmd-recover.js";
import { cmdReplay } from "./cmd-replay.js";
import { cmdRun } from "./cmd-run.js";
import { cmdScenario } from "./cmd-scenario.js";
import { cmdValidate } from "./cmd-validate.js";

const USAGE = `keel — Phase 1 验收场景执行入口（命令面见 docs/design/phase-1/04-cli-benchmarks-fixtures.md §2）

用法：
  keel run --manifest <path> --plugin <path> [--tool ok] [--rounds 2] [--data-dir <dir>]
  keel recover --data-dir <dir> --run <runId> [--plugin <path>] [--manifest <path>] [--tool get-state]
  keel replay --data-dir <dir> --run <runId>
  keel validate (--manifest <path> | --dir <dir>) [--expect accept|reject]
  keel observe --plugin <path> [--entry legacy|default] [--out <dir>] [--tool-timeout 5000] [--data-dir <dir>]
  keel hotswap [--data-dir <dir>]
  keel bench
  keel scenario <a2|a3|a4|a5>

前置：pnpm build（子进程只能跑 dist）。`;

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const str = (v: string | boolean | undefined): string => (typeof v === "string" ? v : "");
const optNum = (v: string | boolean | undefined): number | undefined =>
  typeof v === "string" && v !== "" ? Number(v) : undefined;

/** CLI 主入口（导出供测试直接调用）。 */
export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  try {
    switch (cmd) {
      case "run":
        return await cmdRun({
          manifest: str(a.manifest),
          plugin: str(a.plugin),
          tool: str(a.tool) || undefined,
          rounds: optNum(a.rounds),
          dataDir: str(a["data-dir"]) || undefined,
        });
      case "recover":
        return await cmdRecover({
          dataDir: str(a["data-dir"]),
          run: str(a.run),
          plugin: str(a.plugin) || undefined,
          manifest: str(a.manifest) || undefined,
          tool: str(a.tool) || undefined,
        });
      case "replay":
        return await cmdReplay({ dataDir: str(a["data-dir"]), run: str(a.run) });
      case "validate": {
        const expect = str(a.expect);
        return await cmdValidate({
          manifest: str(a.manifest) || undefined,
          dir: str(a.dir) || undefined,
          expect: expect === "accept" || expect === "reject" ? expect : undefined,
        });
      }
      case "observe":
        return await cmdObserve({
          plugin: str(a.plugin),
          entry: str(a.entry) || undefined,
          out: str(a.out) || undefined,
          dataDir: str(a["data-dir"]) || undefined,
          toolTimeoutMs: optNum(a["tool-timeout"]),
        });
      case "hotswap":
        return await cmdHotswap({ dataDir: str(a["data-dir"]) || undefined });
      case "bench":
        return await cmdBench({ rounds: optNum(a.rounds) });
      case "scenario":
        return await cmdScenario(rest[0] ?? "");
      default:
        console.error(USAGE);
        return cmd === undefined ? 0 : 2;
    }
  } catch (err) {
    console.error(`keel ${cmd}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/* bin 入口：dist/main.js 直接执行时分发；被测试 import 时无副作用 */
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (invoked) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error(USAGE);
    process.exitCode = 0;
  } else {
    void main(argv).then((code) => {
      process.exitCode = code;
    });
  }
}
