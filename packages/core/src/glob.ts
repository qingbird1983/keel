/**
 * 极简 glob 匹配：`**` 跨段、`*` 段内不跨 `/`、`?` 单字符。
 * 用途：授权资源限定符与 manifest allow 路径模式（manifest §5.2；方言细节为实现期待决 §11）。
 */

function escapeRegexChar(c: string): string {
  return /[.+^${}()|[\]\\*?]/.test(c) ? `\\${c}` : c;
}

function segmentToRegex(seg: string): string {
  let re = "";
  for (const c of seg) {
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += escapeRegexChar(c);
  }
  return re;
}

/** 判断 value 是否匹配 pattern。 */
export function globMatch(pattern: string, value: string): boolean {
  const segments = pattern.split("/");
  let re = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "**") {
      // 尾段 ** 匹配任意余串；中间段 ** 匹配零或多个完整段
      re += i === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
    } else {
      re += segmentToRegex(seg);
      if (i < segments.length - 1) re += "/";
    }
  }
  return new RegExp(`^${re}$`).test(value);
}
