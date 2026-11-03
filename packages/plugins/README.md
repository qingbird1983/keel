# packages/plugins —— Keel 原生标杆插件

Phase 3 的原生 manifest 插件目录（[合同](../../docs/roadmap/phase-3-native-ecosystem.md) §2 目录定案）。首批三件套：`echo` / `file-write` / `param-guard`（需求卡见 [02 稿](../../docs/design/phase-3/02-review-mechanization.md) §4）。

- 每个插件是 workspace 包（private、零三方依赖）；manifest 是插件行为的唯一事实源
- 转正前置：禁面扫描零命中（`node scripts/scan-native-plugins.mjs`）+ `REVIEW.md` 逐条留痕
- 本文件是占位说明（空目录不入库）；切片② 起落插件
