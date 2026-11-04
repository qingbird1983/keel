/**
 * 严格 YAML 子集解析器（Phase 4 切片②，01 稿 P1）——零依赖。
 *
 * 支持：块映射 / 块序列 / 标量（plain、单引号、双引号 JSON 转义）/ 注释 / 空值。
 * **不支持**（遇到即硬失败并给行号，绝不猜测或静默忽略）：
 * 锚点 `&`、别名 `*`、flow 集合 `[...]` / `{...}`、多文档 `---` / `...`、块标量 `|` / `>`。
 *
 * 为什么不用宽松解析：装配清单把"哪个插件、用哪份报关单"钉成事实，YAML 的静默解析差异
 * （别名展开、重复键覆盖、flow 集合的隐式类型）会把装配面变成隐患。宁可拒绝，也不接受
 * 一份"看起来能跑"的清单。
 */

import { KeelError } from "@keel/core";

interface Line {
  /** 缩进空格数（tab 在缩进位置直接拒绝）。 */
  indent: number;
  text: string;
  line: number;
}

function fail(line: number, cause: string): never {
  throw new KeelError("SCHED/MANIFEST-INVALID", `profile yaml: line ${line}: ${cause}`, {
    stage: "parse",
    line,
    cause,
  });
}

/** 去掉行内注释：只认引号外、前面是空白（或行首）的 `#`。 */
function stripComment(s: string, line: number): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") {
        if (s[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(s[i - 1] as string))) {
      return s.slice(0, i).trimEnd();
    }
  }
  if (quote) fail(line, `unterminated ${quote} string`);
  return s.trimEnd();
}

function tokenize(source: string): Line[] {
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Line[] = [];
  raw.forEach((lineText, idx) => {
    const line = idx + 1;
    if (/^[ ]*\t/.test(lineText) || /^\t/.test(lineText)) {
      fail(line, "tab indentation is not supported");
    }
    const trimmedStart = lineText.replace(/^ +/, "");
    if (trimmedStart === "" || trimmedStart.startsWith("#")) return;
    const indent = lineText.length - trimmedStart.length;
    const text = stripComment(trimmedStart, line);
    if (text === "") return;
    if (text === "---" || text === "..." || text.startsWith("--- ") || text.startsWith("... ")) {
      fail(line, "multi-document markers are not supported");
    }
    out.push({ indent, text, line });
  });
  return out;
}

class Cursor {
  constructor(
    readonly lines: Line[],
    public i = 0,
  ) {}
  peek(): Line | undefined {
    return this.lines[this.i];
  }
  next(): Line {
    const l = this.lines[this.i++];
    if (!l) throw new Error("cursor exhausted");
    return l;
  }
}

const KEY_RE = /^[A-Za-z_$][A-Za-z0-9_.$-]*$/;
const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isSeqItem(l: Line): boolean {
  return l.text === "-" || l.text.startsWith("- ");
}

function parseScalar(text: string, line: number): unknown {
  if (text === "") return null;
  const first = text[0];
  if (first === "&" || first === "*") {
    fail(line, first === "&" ? "anchors are not supported" : "aliases are not supported");
  }
  if (first === "[" || first === "{") fail(line, "flow collections are not supported");
  if (first === "|" || first === ">") fail(line, "block scalars are not supported");
  if (first === '"') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(line, "invalid double-quoted scalar");
    }
    if (typeof parsed !== "string") fail(line, "double-quoted scalar must be a string");
    return parsed;
  }
  if (first === "'") {
    if (!text.endsWith("'") || text.length < 2) fail(line, "unterminated single-quoted scalar");
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (NUM_RE.test(text)) return Number(text);
  return text;
}

/** `key: value` 的拆分（冒号后必须是空白或行尾；key 只允许 plain 标识符）。 */
function splitEntry(text: string, line: number): { key: string; rest: string } {
  const m = /^([^\s:]+):(?:[ ](.*))?$/.exec(text) ?? /^([^\s:]+):$/.exec(text);
  if (!m) fail(line, `expected "key: value" or "key:"`);
  const key = m[1] as string;
  if (!KEY_RE.test(key)) fail(line, `unsupported key "${key}"`);
  return { key, rest: (m[2] ?? "").trim() };
}

function parseNode(c: Cursor, indent: number): unknown {
  const first = c.peek();
  if (!first) fail(1, "unexpected end of document");
  if (first.indent !== indent) {
    fail(first.line, `unexpected indentation (expected ${indent}, got ${first.indent})`);
  }
  return isSeqItem(first) ? parseSeq(c, indent) : parseMap(c, indent);
}

function parseSeq(c: Cursor, indent: number): unknown[] {
  const out: unknown[] = [];
  for (;;) {
    const l = c.peek();
    if (!l || l.indent !== indent || !isSeqItem(l)) {
      if (l && l.indent > indent) fail(l.line, "unexpected indentation inside sequence");
      break;
    }
    c.next();
    const afterDash = l.text.slice(1);
    const spaces = afterDash.length - afterDash.replace(/^ +/, "").length;
    const rest = afterDash.trim();
    if (rest === "") {
      const next = c.peek();
      out.push(next && next.indent > indent ? parseNode(c, next.indent) : null);
      continue;
    }
    const itemIndent = indent + 1 + spaces;
    if (/^[^\s:]+:(\s|$)/.test(rest)) {
      const obj: Record<string, unknown> = {};
      parseEntryInto(c, obj, rest, l.line, itemIndent);
      parseMapInto(c, obj, itemIndent);
      out.push(obj);
    } else {
      out.push(parseScalar(rest, l.line));
    }
  }
  return out;
}

function parseMap(c: Cursor, indent: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  parseMapInto(c, obj, indent);
  return obj;
}

function parseMapInto(c: Cursor, obj: Record<string, unknown>, indent: number): void {
  for (;;) {
    const l = c.peek();
    if (!l || l.indent < indent) return;
    if (l.indent > indent) fail(l.line, "unexpected indentation inside mapping");
    if (isSeqItem(l)) fail(l.line, "sequence item where mapping key expected");
    c.next();
    parseEntryInto(c, obj, l.text, l.line, indent);
  }
}

function parseEntryInto(
  c: Cursor,
  obj: Record<string, unknown>,
  text: string,
  line: number,
  ownerIndent: number,
): void {
  const { key, rest } = splitEntry(text, line);
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    fail(line, `duplicate key "${key}"`);
  }
  if (rest === "") {
    const next = c.peek();
    obj[key] = next && next.indent > ownerIndent ? parseNode(c, next.indent) : null;
  } else {
    obj[key] = parseScalar(rest, line);
  }
}

/**
 * 解析严格 YAML 子集；返回与 `.json` 同构的值。
 * 解析失败抛 `SCHED/MANIFEST-INVALID`（detail = `{stage:"parse", line, cause}`）。
 */
export function parseYamlSubset(source: string): unknown {
  const c = new Cursor(tokenize(source));
  if (c.lines.length === 0) return null;
  const first = c.peek() as Line;
  if (first.indent !== 0) fail(first.line, "document must start at column 0");
  const value = parseNode(c, 0);
  const tail = c.peek();
  if (tail) fail(tail.line, "unexpected content after document");
  return value;
}
