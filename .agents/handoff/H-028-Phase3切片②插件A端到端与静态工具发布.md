# H-028-Phase3切片②插件A端到端与静态工具发布

- 日期：2026-11-03
- 范围：切片② 全程——03 稿两道闸定稿、事实核对（F1~F5）、缺口 F4 处置（内核静态工具发布）、`packages/plugins/echo` 落地、E1~E6 真进程验收、REVIEW.md 转正留痕
- 本轮性质：首个原生插件端到端 + 内核行为补齐（红测先行）+ 集成面收口

## 本轮做了什么

1. **03 稿两道闸**：提纲+五决策点（D1 缺口修复方案 / D2 不新增 ADR / D3 测试落点 / D4 基准切片④采 / D5 REVIEW 切片②写）→ 确认 → 全文定稿（`docs/design/phase-3/03-plugin-a-echo.md`，含 E1~E6 验收剧本）
2. **事实核对**：F1 tool.provide 声明形状 / F2 装载门就绪凭据 / F3 scope 绑定装配写法 / **F4 缺口：默认入口只本地登记不发布，静态工具对决策输入全盲**（ADR-0011 声称关掉的"首轮空表"对原生插件还开着）/ F5 插件包零依赖零 import（B4-deps 连 @keel/* 类型都禁）
3. **红测先行**：`tests/native-echo-e2e.test.ts`（E1~E6）先于内核补丁——补丁前 E1 发现面红（`[[],[],[]]` 三轮全盲）+ E4 红，补丁后 5/5 绿
4. **内核补齐（D1 方案 1）**：`main.ts` 装载义务 = 本地登记 **和** 经既有 op `tool.register` 的跨进程发布（与承接层两步式同形），完成才 `markReady()`；任一发布失败 = 进程 crash（可见失败优于静默降级）；ADR-0011 追加带日期实施注记（不新增 ADR，D2）
5. **echo 包**：`packages/plugins/echo/`（真报关单 keel-plugin.json + 零 import src + 包内单测 3 条 + REVIEW.md 五段留痕）；workspace 增一行 `packages/plugins/*`（03 稿 §5.1 初稿"零根配置改动"有误，已带注记修正）
6. **集成面收口（03 稿 §4.5）**：发布一通后"宿主必须编译报关单规则"成硬前提——CLI 五处（scenario a2/a3/a4 policy 位、hotswap、recover、bench B3 改走 wireCell）+ 8 个 rig 补 register/remove 规则；两个被炸出来的 rig 潜伏缺陷（serveCellChannel 漏传 deps / 残缺 deps / serve 前被 await 隔开）修复；A1（一票否决承载）boot 状态加"等静态发布落分区"栅栏并重算指纹/计数（静态 3 / 动态 6，ok v2 起）
7. **扫描器载体收窄**：test/ 目录与 *.test.* 文件排除（02 稿 §7 带日期注记——插件单测必须 import vitest，运行面 = src→dist；**不是符号豁免**）
8. **P-002 复发记录**：同款接线坑三种形（漏传/残缺/晚挂）+ 装配次序硬约束（spawn 后任何 await 前挂好 serve+alloc）+ "内核收紧暴露存量潜伏缺陷是收益不是回归"的处置口径

## 验证

- 六道门禁全绿：build / typecheck / lint / format / **test 43 文件 344 测试**（含 echo 单测 3 + e2e 5）/ check-size（0 提醒）
- `node scripts/scan-native-plugins.mjs` = clean（exit 0，echo 实体入扫）
- 红测先行证据链：E1/E4 补丁前红、补丁后绿（vitest 输出留档本轮会话）
- CLI 随 apps/keel 测试 9/9 绿（scenario 四场景 + hotswap 等）

## 遗留与下一步

1. **切片③**：插件 B `file-write`（补偿闭环，锚 C3【一票否决】）+ 插件 C `param-guard`（策略拦截，锚 C4）；策略舱路径注意 ADR-0012 与 hook 白名单；插件 B 会第一次用到补偿模板声明 + EFFECT 闭环
2. **切片④**：manifest 规范回填（如修订走 ADR）+ 阶段验收 C1~C7 复核 + report.md + 基准复采（D4：三件套齐后统一采插件自身开销）
3. 覆盖空窗核对（合同风险 1）：三件套落地后核对注册/装载门/补偿/策略链的等强度覆盖
4. 老项不变：根 `tests/` 类型检查缺口（本轮三个 rig 潜伏缺陷全靠它掩盖，价值再证）、CI checkout 版本

## 已提取的沉淀

- P-002 复发记录（见上 8）；扫描器载体收窄登记 02 稿 §7；F4 缺口登记与集成面全记录在 03 稿 §2/§4.5
