# H-015-Phase1阶段验收收官

- 日期：2026-11-02
- 范围：Phase 1 阶段验收（A1~A8 逐条实测）+ 交付物补齐（Cordis Adapter 原型）+ 报告收口与收官提交

## 本轮做了什么

1. **A1 规模级补执行**：新 `tests/concurrent-scope-isolation.test.ts`（真实进程 20 舱 ×5 轮，增删经 Cordis 适配器施加）——可见表逐轮等于自身剧本、静止对照域指纹五轮恒定、变更域指纹变化轮次恰为 [2,3,4]、`TOOL_SCHEMA_CHANGED` 条数与 `affectedScope` 逐条核对、他域名零出现、708 事件 209~258ms、宿主 RSS 增量 6~7MiB；3 次复跑逐项一致
2. **A6 规模级补执行**：新 `tests/audit-attribution-replay.test.ts`（真实进程一个 run 五轮四分支：放行 / Core 拒 / hook① 否决 / 模型首败→hook③ 重试）——51 事件 seq 1..51 连续、8 对 hook 留痕且 `fallback=false`、否决支无 TOOL_INVOKE、`basedOn` 只引用已发生事件并覆盖上轮全部裁决、冷实例复读 + `keel replay` 子进程 52 行可读输出
3. **A7 实测补强**：新 `tests/gateway-fail-closed.test.ts` + `tests/fixtures/fail-closed-plugin.mjs`（真实 Cell 内四路径）——越权工具/越权模型各留 AUTH_DENIED、越权模型零预扣零上游调用、合法调用预扣 100 实结 60 退 40、同 reqId 重放 `replay=true` 且上游恰好 1 次
4. **交付物补齐**：`packages/cordis-adapter` 由空占位补成接口级原型（142 行 + 9 单测），先写设计稿 `docs/design/phase-1/05-cordis-adapter-prototype.md`（接口面三条规则 / 有损边界显式报错清单 / 三条实现期定案），docs/README 登记，包 README 状态改写
5. **验收拦缺陷修复（复现先行）**：`apps/keel/src/cmd-replay.ts` 的 BUDGET_SETTLED 行错取 `reqId`（载荷实为 `reservationId`）显示 `req=undefined` → 改 `res=`；TOOL_SCHEMA_CHANGED 走 default 被 100 字符截断丢 `affectedScope` → 单列格式。红→绿由 A6 测试第⑤条承载
6. **报告与收官文档**：`docs/design/phase-1/report.md` 重写为验收收口版（结论 / 结果表 / A1 与 A6 口径与数据 / 发现与限制五则 / 契约五点核对 / A8 复采 / 架构接缝 / 体量 / 规范复查四问 / 风险 / 对 Phase 2 影响 / 文档清单）；roadmap 看板 Phase 1 → ✅ 完成；phase-1-mvp §3 前置与 §5 A1~A8 勾选；CHANGELOG 0.1.019

## 验证

- 六道门禁全绿（GATES_EXIT=0）；225 测试 / 29 文件（208 → +17）；三份新集成测试 3 次复跑逐项一致；`keel scenario a2|a3|a4|a5` 各 3 次全 PASS；`keel bench` 复采与首采同量级（B1 24548 events/s、B1b 0.84ms、B2 0.2ms、B3 36/37ms、B4 1.5/0.7/0.7ms）
- check-size：docs 27 篇、.agents 11 文件、CONTEXT 行数、单文件最大 569 行、产物 412KB——0 超限 0 提醒

## 关键实现决策（评审锚点）

- **"缓存命中率稳定"的口径 = 工具表指纹**（升序 `name@version` 序列化）；主张拆成"未变更者恒定 + 变更者变化轮次等于自身剧本轮次"，两条都是确定的可断言量
- **A6/A7 不新增 CLI 命令**：验收主张由 tests/ 真实进程集成承载，CLI 侧只复用已有 `replay`（04 稿命令面未被改动，避免定稿文档的口径漂移）
- **适配器不自存工具表**：版本号从 `ctx.discover(ref)` 现有条目推导（单一事实源 = Core 分区），否则等于把全局注册表搬进 Keel
- **`ADAPTER/*` 错误码不入契约 §6 词表**：注册期本地错误，不落账本、不过通道（05 稿 §3 明文）
- **basedOn 依据集范围**：登记为限制而非改核心语义（扩集 = 契约 §4.1/§5 语义变更，须 ADR）

## 遗留与下一步

- **Phase 1 收官后未开工任何东西**；下一动作 = Phase 2 前置：先产出**显式迁移边界文档**（roadmap 风险簿要求），并清回填项：策略插件→HookBus 装配链、`model.stream`（契约 §4.7）、旧 Cell drain 完整语义、快照物理持久化、basedOn 语义（需 ADR）
- 规范复查两条发现待处置（下一轮规范修订）：交付物完成度缺机械核对（建议写进 standards/07 验收节）、`tests/` 不在 typecheck 覆盖内（建议根级 tsc 项目或 type-aware lint）
- backlog 不变；三个 ADR 重评条件仍无触发迹象
- 未决（所有者）：git 远端地址、版权署名占位

## 已提取的沉淀

- S-001（阶段验收执行法：抽象主张找可断言口径 + 交付物横向核对 + 证据行）；P-002 追加第 4 条（跨包 import 走 dist，改 src 未 rebuild 会得到 `x is not a function`）
