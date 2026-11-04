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
  keel run --manifest <path> --plugin <path> [--tool ok] [--rounds 2] [--data-dir <dir>] [--snapshots <dir>]
          [--policy-manifest <path> --policy-module <path>]…（成对、可重复；策略舱见 ADR-0012）
  keel run --profile <profile.yaml> [--tool ok] [--rounds 2] [--data-dir <dir>] [--snapshots <dir>]
          （Phase 4：一份清单拉起全家桶；--manifest/--plugin 与 --profile 互斥）
  keel recover --data-dir <dir> --run <runId> [--snapshots <dir>] [--plugin <path>] [--manifest <path>] [--tool get-state]
  keel replay --data-dir <dir> --run <runId>
  keel validate (--manifest <path> | --dir <dir> | --profile <path>) [--expect accept|reject]
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

/**
 * 可重复的开关（切片④：`--policy-manifest` / `--policy-module` 各给 N 次 = N 份策略绑定）。
 * `parseArgs` 是"后者覆盖前者"的形状，对成对且可重复的开关不适用，所以单独扫一遍 argv。
 */
function parseList(argv: string[], key: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${key}` && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      out.push(argv[++i]);
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
      case "run": {
        const policyManifests = parseList(rest, "policy-manifest");
        const policyModules = parseList(rest, "policy-module");
        if (policyManifests.length !== policyModules.length) {
          console.error(
            "--policy-manifest and --policy-module must appear the same number of times (paired)",
          );
          return 2;
        }
        const profile = str(a.profile);
        const manifest = str(a.manifest);
        const plugin = str(a.plugin);
        if (profile !== "" && (manifest !== "" || plugin !== "")) {
          console.error(
            "--profile cannot be combined with --manifest/--plugin (mutually exclusive)",
          );
          return 2;
        }
        if (profile !== "" && (policyManifests.length > 0 || policyModules.length > 0)) {
          console.error(
            "--profile declares policies in the profile file; --policy-manifest/--policy-module do not apply",
          );
          return 2;
        }
        return await cmdRun({
          manifest: manifest || undefined,
          plugin: plugin || undefined,
          profile: profile || undefined,
          tool: str(a.tool) || undefined,
          rounds: optNum(a.rounds),
          dataDir: str(a["data-dir"]) || undefined,
          snapshotDir: str(a.snapshots) || undefined,
          policyManifests,
          policyModules,
        });
      }
      case "recover":
        return await cmdRecover({
          dataDir: str(a["data-dir"]),
          snapshotDir: str(a.snapshots) || undefined,
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
          profile: str(a.profile) || undefined,
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
