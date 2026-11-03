# H-027-Phase3开工合同定稿与评审机械化

- 日期：2026-11-03
- 范围：所有者四项决定落地——`phase-2.end` tag、cordis 测试剥离主线门禁、Phase 3 合同定稿（三件套）、切片①（评审机械化 + 需求卡）
- 本轮性质：决策落地 + 门禁配置 + 新扫描器（先红后绿）

## 本轮做了什么

1. **tag**：`phase-2.end`（annotated，附言所有者定稿）打在换轨合并提交上，已推送
2. **ADR-0014 实施注记**：四项后继决定入档——① 首批插件改"底层测试驱动三件套"（A `echo` 只读 / B `file-write` 补偿闭环 / C `param-guard` 策略拦截；原业务候选 P-A~P-D 作废）；② 验收场景只留锚五大不变量的条目（业务层移 Phase 4/backlog）；③ cordis 测试剥离主线门禁（取代"故意留在门禁"的过渡安排，覆盖空窗风险如实登记，替补 = 三件套的 C1/C3/C4）；④ tag 立即打
3. **门禁剥离**：`vitest.config.ts` exclude `tests/cordis-*.test.ts` + `packages/cordis-adapter/test/**`（用 `configDefaults.exclude` 展开防误覆盖默认排除）；12 个文件头加归档横幅；**内核命名测试（快照/流式/throughSeq/策略链）保留**，单独复跑 19 条全绿
4. **Phase 3 合同定稿**：三件套 + C1~C7（每条注不变量锚 + 一票否决三条：C1/C2/C3）+ 风险 1 = 覆盖空窗；目录定案 `packages/plugins/<name>/`（不新增仓库根目录）；流式记账场景延后启用
5. **切片① 施工（红测先行）**：`docs/design/phase-3/02-review-mechanization.md`（禁面符号表：01 清单 18 类 → 15 条机械判据 + 3 条走别关卡的登记；三件套需求卡；REVIEW.md 留痕口径）；`scripts/scan-native-plugins.mjs`（扫描器，CLI 可直跑）；`tests/native-plugin-scan.test.ts`（负样本组逐判据必红 + 实扫组必净 + 完备性断言防漏报）。**红在 import 缺失，绿在逐判据命中**；A3 判据按"故意过收"放宽为无词边界（驼峰 `remainingBudget` 也要命中）
6. **登记**：docs/README（合同翻定稿 + 02 稿新行）、看板（Phase 3 行 → 进行中、切片① 已完成、最近更新）、CHANGELOG 0.1.042、`packages/plugins/README.md` 占位

## 验证

- 红测先行：测试先于扫描器存在（`Cannot find module` = 红）
- 内核保留测试单独复跑 19 条全绿；六道门禁另见收尾提交（从 clean 起）
- `node scripts/scan-native-plugins.mjs` 退出码 0（packages/plugins 占位干净）

## 遗留与下一步

1. **切片②（插件 A `echo` 端到端）**：manifest → 装载门 → scope 授权 → 真进程 run（锚 C1/C5/C6）；开工前先做事实核对（manifest schema 的 tool.provide 声明形状与装载门凭据口径）
2. 切片③（插件 B + C）、切片④（规范回填 + 阶段收口）依次
3. `keel observe` 改造口径（D2/D3 拆问）挂 Phase 3 脚手架改造时落实（02 稿 §2 已登记防漏）
4. 老项不变：根 `tests/` 类型检查缺口、CI checkout 版本

## 已提取的沉淀

- 本轮无新 pitfall（A3 词边界是设计意图修正，不是返工级教训）；P-012 的"自我宣判拆问"直接塑形了负样本组设计
