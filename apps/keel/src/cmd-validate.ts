/**
 * keel validate —— manifest 装配五步校验复演（A5 结构 + 语义负路径；04 稿 §2）。
 * 单文件或目录批量；--expect reject 时任一文件未被拒即失败（fixtures/manifest-negative 复演入口）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { KeelError } from "@keel/core";
import { Assembler, loadProfile } from "@keel/host";
import { assembleManifest, loadProfileSchema, loadSchema } from "./runtime.js";

export interface ValidateOptions {
  /** 单 manifest 文件路径。 */
  manifest?: string;
  /** 目录批量（取 *.json，文件名排序）。 */
  dir?: string;
  /** profile.yaml 路径（Phase 4 切片②：只校验不拉起，供 CI 用）。 */
  profile?: string;
  /** 期望结果（缺省：单文件 accept，目录 reject）。 */
  expect?: "accept" | "reject";
}

export interface ValidateResult {
  file: string;
  ok: boolean;
  code?: string;
  message?: string;
}

/** 批量装配校验（scenario a5 与本命令共用）。 */
export function validateTargets(files: string[]): ValidateResult[] {
  return files.map((file) => {
    try {
      assembleManifest(JSON.parse(readFileSync(file, "utf-8")));
      return { file, ok: true };
    } catch (err) {
      return {
        file,
        ok: false,
        code: err instanceof KeelError ? err.code : "UNKNOWN",
        message: err instanceof Error ? err.message.split("\n")[0] : String(err),
      };
    }
  });
}

export function listManifestFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** @returns 退出码：0 = 全部符合期望；1 = 有偏差；2 = 参数不合法。 */
export async function cmdValidate(opts: ValidateOptions): Promise<number> {
  if (opts.profile) return validateProfile(opts.profile, opts.expect);
  const expect = opts.expect ?? (opts.dir && !opts.manifest ? "reject" : "accept");
  let files: string[];
  if (opts.manifest) files = [opts.manifest];
  else if (opts.dir) files = listManifestFiles(opts.dir);
  else {
    console.error("validate: --manifest <path> 或 --dir <dir> 必提供一个");
    return 2;
  }
  if (files.length === 0) {
    console.error("validate: no manifest files found");
    return 2;
  }
  const results = validateTargets(files);
  let bad = 0;
  for (const r of results) {
    const tag = r.ok ? "ACCEPT" : "REJECT";
    const tail = r.ok ? "" : ` — ${r.code}: ${r.message}`;
    console.info(`${tag}  ${path.basename(r.file)}${tail}`);
    if ((expect === "reject" && r.ok) || (expect === "accept" && !r.ok)) bad++;
  }
  console.info(`— ${results.length} file(s), expect=${expect}, mismatch=${bad}`);
  return bad === 0 ? 0 : 1;
}

/**
 * `keel validate --profile`（Phase 4 切片② P10）：解析 + schema + 逐 manifest 五步校验 +
 * 交叉校验，**不拉起任何运行时**。engine.tools 的提供者归属要等真实注册，归 `run --profile`。
 */
function validateProfile(file: string, expect: ValidateOptions["expect"]): number {
  const want = expect ?? "accept";
  try {
    const plan = loadProfile(file, {
      profileSchema: loadProfileSchema(),
      assembler: new Assembler({ schema: loadSchema() }),
    });
    console.info(`ACCEPT  ${path.basename(file)} (${plan.plugins.length} plugins)`);
    return want === "reject" ? 1 : 0;
  } catch (err) {
    const tail =
      err instanceof KeelError
        ? `${err.code}: ${err.message.split("\n")[0]}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.info(`REJECT  ${path.basename(file)} — ${tail}`);
    return want === "reject" ? 0 : 1;
  }
}
