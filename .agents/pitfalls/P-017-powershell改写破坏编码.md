# P-017：用 PowerShell 批量替换改写 Markdown 会毁掉编码与换行

- 日期：2026-11-04
- 触发场景：`(Get-Content x -Raw) -replace 'a','b' | Set-Content -NoNewline x`

## 现象

改写后的中文文档出现乱码（`�?`），且相邻两行被合并成一行（状态行与日期行黏在一起）。`git diff` 显示整文件重写。

## 根因

1. Windows PowerShell 5.1 的 `Set-Content` 缺省不是 UTF-8（按 ANSI/UTF-16 写），中文直接损坏；
2. `-NoNewline` 把行尾与文件末尾的换行一起削掉，`-Raw` 读入的多行内容在写回时失去边界；
3. `Get-Content -Raw` 的编码探测与写回编码不一致，进一步放大损坏。

即使 `-Encoding utf8` 也只能修第 1 条，第 2、3 条仍会咬人——**批处理文本不是本项目该走的路**。

## 修复

`git checkout -- <file>` 恢复，改用 `edit` 工具逐处替换；需要批量时写 Node 脚本并显式 `utf8`。

## 预防

- 改仓库内任何文本：一律用 `edit` / `write` 工具；不要用 shell 的 in-place 文本替换。
- 需要脚本化批处理时：Node + `readFileSync(p, "utf8")` / `writeFileSync(p, s, "utf8")`，bat 处理前先 `git status` 留退路。
- 改完立即 `git diff --stat` 复核：整文件重写 = 编码事故的信号。
