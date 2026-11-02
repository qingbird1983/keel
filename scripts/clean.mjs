// clean —— 清理各包构建产物与覆盖率目录（standards/08 §6；入口 `pnpm clean`）
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const group of ["packages", "apps"]) {
  const base = path.join(root, group);
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    continue; // 组目录尚未建立时静默跳过
  }
  for (const entry of entries) {
    for (const name of ["dist", "coverage"]) {
      rmSync(path.join(base, entry, name), { recursive: true, force: true });
    }
  }
}
console.info("clean: removed dist/ under packages/* and apps/*");
