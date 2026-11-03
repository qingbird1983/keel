// 原生插件禁面扫描器（Phase 3 切片①，design/phase-3/02 稿 §2/§3）。
// 禁面判据的唯一代码事实源；01 清单（docs/design/phase-3/01-legacy-anti-patterns.md）是语义来源，只增不改。
// 刻意过收（宁误报不漏报）：命中 = 插件不可转正，无白名单豁免通道；误报时改插件写法绕开歧义。
//
// CLI：node scripts/scan-native-plugins.mjs [dir]   —— 缺省扫 packages/plugins，命中即退出码 1。
// 门禁：tests/native-plugin-scan.test.ts（负样本组证明扫描器有效 + 实扫组证明在库插件干净）。
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 机械判据表：id 稳定（负样本引用）、row 对应 01 清单行号 */
export const FORBIDDEN_SURFACES = [
  {
    id: "A1",
    row: "A1",
    media: "code",
    pattern: /\bsystemPrompt\b/,
    note: "提示词贡献面进 manifest，不进代码",
  },
  { id: "A2", row: "A2", media: "code", pattern: /\bconcludeTurn\b/, note: "工具不得宣告本轮结束" },
  {
    id: "A3",
    row: "A3",
    media: "code",
    pattern: /budget/i,
    note: "预算只读账本，不得自算（无词边界，驼峰也命中）",
  },
  {
    id: "A4",
    row: "A4",
    media: "code",
    pattern: /\bdeferContext\b/,
    note: "结果不得夹带下一条指令",
  },
  {
    id: "B1",
    row: "B1",
    media: "code",
    pattern: /\bsandbox_permissions\b|\bapprovalSvc\b|approval\s*\.\s*request\b/,
    note: "运行中提权",
  },
  {
    id: "B2",
    row: "B2",
    media: "code",
    pattern: /\bexec\s*\.\s*agent\b|\bsessionId\b/,
    note: "身份由通道盖章，插件不持有",
  },
  {
    id: "B3",
    row: "B3",
    media: "code",
    pattern: /\bctx\s*\.\s*get\s*\(/,
    note: "服务定位绕过授权与留痕",
  },
  {
    id: "B5",
    row: "B5",
    media: "code",
    pattern: /\btimeoutMs\b|\bisConcurrencySafe\b/,
    note: "可调度量进 manifest 不进代码",
  },
  {
    id: "C1",
    row: "C1",
    media: "code",
    pattern: /\bctx\s*\.\s*(provide|inject)\b/,
    note: "跨插件扩展点通道",
  },
  {
    id: "C2",
    row: "C2",
    media: "code",
    pattern: /\bctx\s*\.\s*bus\b|\bbus\s*\.\s*(emit|on)\b/,
    note: "事件总线级联",
  },
  {
    id: "C3",
    row: "C3",
    media: "code",
    pattern: /\bctx\s*\.\s*(share|state)\b/,
    note: "共享可变状态",
  },
  {
    id: "C4",
    row: "C4",
    media: "all",
    pattern: /cordis\.patch|patch\.yml|\bdsh\./,
    note: "行为定义在插件之外",
  },
  {
    id: "D1",
    row: "D1",
    media: "code",
    pattern: /\bactivate\s*\(|\bapply\s*\(\s*ctx\b/,
    note: "旧框架入口形状",
  },
  {
    id: "D3",
    row: "D3",
    media: "code",
    pattern: /dsh\s*\.\s*client|platform\s*[:=]\s*["']web["']/,
    note: "浏览器半",
  },
  {
    id: "B4-import",
    row: "B4",
    media: "imports",
    note: "import 说明符必须在 @keel/* / 相对路径 / node: 白名单内",
  },
  { id: "B4-deps", row: "B4", media: "package-json", note: "插件 package.json 不得声明任何依赖" },
];

/** 01 清单中"应有机械判据"的行号集合（新行入 01 清单时同步扩这里 + 补负样本） */
export const REQUIRED_ROWS = [
  "A1",
  "A2",
  "A3",
  "A4",
  "B1",
  "B2",
  "B3",
  "B4",
  "B5",
  "C1",
  "C2",
  "C3",
  "C4",
  "D1",
  "D3",
];

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IMPORT_RE =
  /(?:\bimport\s+[^;]*?\bfrom\s*|\bimport\s*\(\s*|\bexport\s+[^;]*?\bfrom\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** @returns {Promise<Array<{file: string, line: number, id: string, row: string, excerpt: string}>>} */
export async function scanNativePlugins(rootDir) {
  const files = await listFiles(rootDir);
  const hits = [];
  for (const file of files) {
    const ext = path.extname(file);
    const isCode = CODE_EXTS.has(ext);
    const isPackageJson = path.basename(file) === "package.json";
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (const rule of FORBIDDEN_SURFACES) {
      if (rule.media === "code" && !isCode) continue;
      if (rule.media === "package-json") {
        if (!isPackageJson) continue;
        const deps = nonEmptyDeps(text);
        if (deps.length > 0) {
          hits.push({
            file,
            line: 1,
            id: rule.id,
            row: rule.row,
            excerpt: `package.json declares: ${deps.join(", ")}`,
          });
        }
        continue;
      }
      if (rule.media === "imports") {
        if (!isCode) continue;
        for (const [i, line] of lines.entries()) {
          IMPORT_RE.lastIndex = 0;
          let m;
          while ((m = IMPORT_RE.exec(line)) !== null) {
            const spec = m[1];
            if (!isAllowedSpecifier(spec)) {
              hits.push({
                file,
                line: i + 1,
                id: rule.id,
                row: rule.row,
                excerpt: line.trim().slice(0, 160),
              });
            }
          }
        }
        continue;
      }
      for (const [i, line] of lines.entries()) {
        if (rule.pattern.test(line)) {
          hits.push({
            file,
            line: i + 1,
            id: rule.id,
            row: rule.row,
            excerpt: line.trim().slice(0, 160),
          });
        }
      }
    }
  }
  return hits;
}

function isAllowedSpecifier(spec) {
  return (
    spec.startsWith("@keel/") ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("node:")
  );
}

function nonEmptyDeps(packageJsonText) {
  try {
    const pkg = JSON.parse(packageJsonText);
    const out = [];
    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const v = pkg[key];
      if (v && typeof v === "object" && Object.keys(v).length > 0)
        out.push(`${key}(${Object.keys(v).join(", ")})`);
    }
    return out;
  } catch {
    return ["package.json is not valid JSON"];
  }
}

async function listFiles(dir) {
  let rootStat;
  try {
    rootStat = await stat(dir);
  } catch {
    throw new Error(
      `native plugin scan target does not exist: ${dir}（先建 packages/plugins/ 再实扫）`,
    );
  }
  if (!rootStat.isDirectory()) throw new Error(`scan target is not a directory: ${dir}`);
  const out = [];
  const walk = async (cur) => {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
        continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target =
    process.argv[2] ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "plugins");
  const hits = await scanNativePlugins(target);
  if (hits.length === 0) {
    console.log(`native-plugin-scan: clean (${target})`);
  } else {
    for (const h of hits) console.log(`${h.file}:${h.line} [${h.row}/${h.id}] ${h.excerpt}`);
    console.error(`native-plugin-scan: ${hits.length} hit(s) — plugin cannot be accepted`);
    process.exitCode = 1;
  }
}
