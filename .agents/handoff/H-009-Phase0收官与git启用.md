# H-009-Phase0收官与git启用

- 日期：2026-11-02
- 范围：Phase 0 收官（report + 看板翻牌）+ MIT + git init

## 本轮做了什么

1. phase-1-mvp.md 转定稿（所有者确认）；LICENSE 替换 MIT 全文（署名 Keel Project Contributors 占位）+ ADR-0006 留痕
2. 提交前自查拦截并清理 H-001 中的本机绝对路径（standards/01 §4 生效实例；初扫的转义模式漏检，宽模式"Warehouse"复查抓到——教训：路径扫描用宽关键词）
3. design/phase-0/report.md：验收 A1~A7 全过（A2/A4 一票否决项通过）、体量核对（docs 22 篇/150、零豁免）、规范复查四问（一险情即规范拦截实例）
4. 看板 Phase 0 ✅（mermaid + 表 + report 链接）、00-roadmap 头部关联扩至 ADR-0006、双 README（状态行/待决策表清空/License 节 MIT）、docs/README、CHANGELOG 0.1.010
5. git init -b main → 首提交（chore(repo)）→ annotated tag phase-0.end

## 验证

- check-size 通过；提交前 grep 确认 briefs 外无绝对路径；git status 确认 briefs/ 未入库（.gitignore 生效）

## 遗留与下一步

- Phase 1 开工（合同已定稿）：① 工具链脚手架（pnpm workspace + 门禁四连实体化）② 纵向切片 A1~A6 ③ 横向 A7/A8
- git 远端未配置（所有者未提供；standards/02 §1"禁止直接 push main"在无远端阶段以本地纪律执行）
- N1~N5 + 契约/状态机待决项随 Phase 1 处理

## 已提取的沉淀

- 路径扫描教训：转义模式（`E:\\`）在 bash 双引号下易漏检——宽关键词（"Warehouse"）复查才可靠 → 已在本卡提醒，暂不单独立 pitfalls（单次险情）
