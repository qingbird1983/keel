/**
 * 机械测试 —— 「零改动」不许靠口头声明（02 稿 §7 判据 1/2/5，锚 B5 的合成组这一半）。
 *
 * 两件事：
 * 1. A 档样本确实是"存量插件的形状"：CommonJS、不 import 任何内核包名与内核符号、ctx 全靠注入；
 * 2. 样本里出现的每一个 `ctx.*` 符号都能在承接面清单（`CORDIS_SURFACE`）里找到归属行——
 *    出现未归类符号即红，处置顺序是**先补边界表再收口**（01 稿 §5 回填义务的机器化）。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CORDIS_SURFACE } from "@keel/cordis-adapter";

const PLUGIN_DIR = path.join(process.cwd(), "tests", "fixtures", "cordis-plugins");

/** 内核侧符号：出现任何一个都说明样本已经被"改成新框架写法"，不再是 A 档证据。 */
const FORBIDDEN_TOKENS = [
  "@keel/",
  "startCell",
  "serveCellChannel",
  "CellClient",
  "FrameConn",
  "ContextManager",
  "registerTool(",
  "cellEntry",
];

function sampleFiles(dir = PLUGIN_DIR, base = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base === "" ? e.name : `${base}/${e.name}`;
    if (e.isDirectory()) return sampleFiles(path.join(dir, e.name), rel);
    return e.name.endsWith(".cjs") ? [rel] : [];
  });
}

/**
 * 剥掉注释后的源码 —— 机械判据只判**代码**：样本里的注释是我们写给评审看的说明文字，
 * 它会提到"不 import 内核包名"这类词组，若连注释一起匹配就是自己绊自己。
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 抽 `ctx.<面>.<方法>` 形式的符号（含 ctx.scope 这类只读字段）。 */
function ctxSymbols(source: string): string[] {
  const out = new Set<string>();
  const re = /\bctx\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codeOf(source))) !== null) {
    out.add(m[2] ? `${m[1]}.${m[2]}` : m[1]);
  }
  return [...out].sort();
}

const ALL_SURFACE = [
  ...CORDIS_SURFACE.mapped,
  ...CORDIS_SURFACE.refused,
  ...CORDIS_SURFACE.withheld,
];

const files = sampleFiles();

describe("A 档合成样本的「零改动」机械判据", () => {
  it("样本组齐备：5 枚常规 + 4 枚探针 + 对照与反例（CommonJS 书写习惯）", () => {
    expect(files.sort()).toEqual(
      [
        "lib/extra-tools.cjs",
        "lib/late-count.cjs",
        "neg-undeclared.cjs",
        "probe-global.cjs",
        "probe-order.cjs",
        "probe-peer.cjs",
        "probe-proto.cjs",
        "probe-require.cjs",
        "tierA-01-toolset.cjs",
        "tierA-02-overwrite.cjs",
        "tierA-02-peer.cjs",
        "tierA-03-dynamic.cjs",
        "tierA-04-crash.cjs",
        "tierA-05-timer.cjs",
      ].sort(),
    );
  });

  it("判据 1/2：源码里没有内核包名与内核符号，且 ctx 一律由注入获得", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = codeOf(readFileSync(path.join(PLUGIN_DIR, f), "utf8"));
      for (const token of FORBIDDEN_TOKENS) {
        if (src.includes(token)) offenders.push(`${f}: ${token}`);
      }
      // 旧框架的插件不 import 框架本身：代码里出现 import 即算改写
      if (/\bimport[\s(*]/.test(src)) offenders.push(`${f}: ESM import（旧形状应为 CommonJS）`);
      if (!/\bmodule\.exports\s*=/.test(src)) offenders.push(`${f}: 未走 CommonJS 导出习惯`);
    }
    expect(offenders).toEqual([]);
  });

  it("判据 5：样本里出现的每个 ctx.* 符号都在承接面清单里有归属行", () => {
    const stray: string[] = [];
    const used = new Set<string>();
    for (const f of files) {
      const src = readFileSync(path.join(PLUGIN_DIR, f), "utf8");
      for (const sym of ctxSymbols(src)) {
        used.add(sym);
        if (!ALL_SURFACE.includes(sym as (typeof ALL_SURFACE)[number])) {
          stray.push(`${f}: ctx.${sym}`);
        }
      }
    }
    expect(stray).toEqual([]);
    // 清单不是空转出来的：三个已映射动作面都被样本真的用过（A 档主张由样本承担）
    for (const mapped of CORDIS_SURFACE.mapped) {
      expect(used.has(mapped), `mapped surface unused by samples: ${mapped}`).toBe(true);
    }
  });

  it("承接面清单本身与边界表口径一致（映射三项 = #1；拒绝项覆盖 #2/#4/#5/#6/#8/#9/#14/#15）", () => {
    expect([...CORDIS_SURFACE.mapped]).toEqual(["tools.register", "tools.remove", "tools.list"]);
    expect(CORDIS_SURFACE.refused).toContain("hooks.register"); // #2 拆支 → #14 D 档
    expect(CORDIS_SURFACE.refused).toContain("bus.emit"); // #15 C 档
    expect(CORDIS_SURFACE.refused).toContain("bus.on");
    expect(CORDIS_SURFACE.refused).toContain("share.get"); // #8
    expect(CORDIS_SURFACE.refused).toContain("effects.reclaim"); // #9
    expect(CORDIS_SURFACE.refused).toContain("llm.chat"); // #6
    expect(CORDIS_SURFACE.refused).toContain("config.get"); // #4
    expect(CORDIS_SURFACE.refused).toContain("net.fetch"); // #5
    expect(CORDIS_SURFACE.withheld).toContain("scope");
  });
});
