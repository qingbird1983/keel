// 原生插件禁面扫描器（Phase 3 切片①，design/phase-3/02 稿 §2/§3；Phase 4 切片①扩 kind 规则，04 稿 §4）。
// 禁面判据的唯一代码事实源；01 清单（docs/design/phase-3/01-legacy-anti-patterns.md）是语义来源，只增不改。
// 刻意过收（宁误报不漏报）：命中 = 插件不可转正，无白名单豁免通道；误报时改插件写法绕开歧义。
//
// Phase 4 起，部分判据**按 manifest 的 kind 生效**（engine 禁出网/禁持密钥；model 禁自报费用）——
// kind 从插件目录的 keel-plugin.json 读取；读不到 = 只跑全局规则（清单本身会在装配期被拒）。
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
  // ── Phase 4 K6（04 稿 §4）：按 kind 生效的新判据 ──────────────────────
  {
    id: "E1-net",
    row: "E1",
    kinds: ["engine"],
    media: "code",
    pattern: /node:(?:http|https|net|tls|dgram)\b|(?<![\w.$])fetch\s*\(/,
    note: "engine 禁直连出网（模型调用走网关）",
  },
  {
    id: "E2-env",
    row: "E2",
    kinds: ["engine", "model"],
    media: "code",
    pattern: /\bprocess\s*\.\s*env\b/,
    note: "密钥只经注入的解析面，不读进程环境",
  },
  {
    id: "E3-ledger",
    row: "E3",
    kinds: ["engine"],
    media: "code",
    pattern:
      /\bledger\s*\.\s*(append|checkpoint|read)\b|\beffect\s*\.\s*declare\b|\bworkspace\s*\.\s*(write|create)\b|\btool\s*\.\s*register\b/,
    note: "engine 无写账本/副作用/注册工具入口（决策交还核心）",
  },
  {
    id: "E4-hook",
    row: "E4",
    kinds: ["engine"],
    media: "code",
    pattern: /\bpolicy\s*\.\s*hook\b|\bhooks?\s*\.\s*register\b/,
    note: "被审者不能自审（hook 归策略舱）",
  },
  {
    id: "E5-key",
    row: "E5",
    media: "code",
    pattern: /sk-[A-Za-z0-9_-]{8,}/,
    note: "密钥明文零出现（D4）",
  },
  {
    id: "M1-cost",
    row: "M1",
    kinds: ["model"],
    media: "code",
    pattern: /\bcost\s*:/,
    note: "费用由核心按价格表算，模型模块不自报 cost",
  },
];

/** Phase 4 新增判据的完整性清单（04 稿 §4；与 01 清单行不同源，单列防止两套编号混用） */
export const REQUIRED_RULE_IDS = ["E1-net", "E2-env", "E3-ledger", "E4-hook", "E5-key", "M1-cost"];

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
  const kinds = await pluginKinds(files);
  const hits = [];
  for (const file of files) {
    const ext = path.extname(file);
    const isCode = CODE_EXTS.has(ext);
    const isPackageJson = path.basename(file) === "package.json";
    const kind = kindOf(file, kinds);
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (const rule of FORBIDDEN_SURFACES) {
      // kind 规则只对声明了对应 kind 的插件生效；读不到清单 = 不跑 kind 规则（装配期另有拒绝）
      if (rule.kinds && !(kind !== null && rule.kinds.includes(kind))) continue;
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

/**
 * 每个插件目录（含 keel-plugin.json 的那一层）→ kind。
 * 读不到或非法 JSON 不入表：kind 规则因此不生效，但清单本身会在装配期被拒（这里不重复判死）。
 */
async function pluginKinds(files) {
  const kinds = new Map();
  for (const file of files) {
    if (path.basename(file) !== "keel-plugin.json") continue;
    try {
      const m = JSON.parse(await readFile(file, "utf8"));
      if (typeof m?.kind === "string") kinds.set(path.dirname(file), m.kind);
    } catch {
      /* 非法清单不是扫描器的判据 */
    }
  }
  return kinds;
}

/** 文件归属的插件根 = 最近的、带清单的祖先目录；不属于任何插件 = null。 */
function kindOf(file, kinds) {
  let dir = path.dirname(file);
  for (;;) {
    const kind = kinds.get(dir);
    if (kind !== undefined) return kind;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
      // test/ 载体排除（02 稿实施注记 2026-11-03，切片②实战检验）：单测只在 vitest 下运行、
      // 永不进入 Cell 进程（运行面 = src → dist），import vitest 属开发侧门禁自身依赖。
      // 这是载体收窄不是符号豁免：被扫文件内禁面符号仍零豁免。
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "test" ||
        entry.name.startsWith(".") ||
        /\.test\.[cm]?[jt]sx?$/.test(entry.name)
      )
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
