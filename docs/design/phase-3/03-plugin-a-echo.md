# Phase 3 切片②：插件 A `echo` 端到端（manifest → 装载门 → scope 授权 → 真进程 run）

- 状态：**定稿**（2026-11-03 所有者确认全文；一经定稿即约束实现——铁律 1）
- 关联：[phase-3 合同](../../roadmap/phase-3-native-ecosystem.md) §7 切片②（锚 C1/C5/C6）；[02 稿](02-review-mechanization.md) §4 需求卡 / §5 留痕口径；[01 反面教材清单](01-legacy-anti-patterns.md)；[manifest 稿](../phase-1/03-plugin-manifest.md)；[ADR-0010](../../adr/ADR-0010-runtime-tool-registration-channel.md) / [ADR-0011](../../adr/ADR-0011-cell-load-gate.md)；standards/05（复现测试先行）

## 1. 这份文档回答什么

切片② = 首个原生插件落地：`packages/plugins/echo/`（manifest + 实现 + 真进程验收）。开工前事实核对（§2）发现一个内核缺口（F4：默认入口不发布静态工具，决策输入看不见原生插件的工具），本稿把它作为切片②的一部分先修——这是合同风险 2 预期的"manifest 规范实战检验"第一次产出：缺口 → 登记本稿 → 处置（D1）→ 才实现，不临场发明 API。

## 2. 事实核对结论（2026-11-03，开工前）

- **F1 `tool.provide` 声明形状**：permissions 项 = `{cap, allow?, reason?}`；`tool.provide` 非越界能力（装配器 `BOUNDARY_CAPS` 不含）→ allow 可选（缺省 `*`）、不要求补偿模板；声明编译为 `tool.register`/`tool.remove` 两条 AuthRule（subject = 授权主体）。capability 必填 `toolCallTimeoutMs`；`compensation.templates: []` 合法；`"^1.0"` 命中 `CONTRACT_VERSION "1.0.0"`。
- **F2 装载门就绪凭据**（ADR-0011）：凭据 = `wireCell()` 内**单次** `cell.snapshot` 探测应答（不重试；5s 超时 → dispose 舱 + `TRANSPORT/TIMEOUT`）。门只挂宿主→Cell 方向（`conn.serve` 内挂起）；Cell→宿主往返不受门影响（承接层 activation 已是先例）。
- **F3 scope 绑定装配写法**：`wireCell({supervisor, deps, scope, ref, subject, manifest, pluginPath})` 四步合一（起舱 → serve 盖章 scope/ref/subject/templates → `ctx.alloc(scope)` → 就绪探测）；起 run = `scheduler.start({ref, subject, executor, driver, assembly})` + `cell.attachRun(ref)`。spawn→serve→alloc 同一同步块，子进程首帧不可能早于宿主接线被处理（FrameConn 对 serve 挂接前的请求回 `BADFRAME`——无竞态窗口）。
- **F4 缺口：原生静态工具不进宿主侧工具表**。系统两张表：Cell 本地执行表（`tool.exec` 的执行依据）vs 宿主侧 scope 分区表（决策输入 `c.tools`、`tool.discover`、`TOOL_SCHEMA_CHANGED` 的唯一来源）；宿主侧表的唯一入口 = 跨进程 op `tool.register`（ADR-0010，带 AUTH 裁决 + 分区写 + 挂起变更）。默认入口 `main.ts` 只做本地登记、无发布步骤（只有承接层 cell-port.ts 做两步式）→ 原生插件静态工具对决策输入不可见：ADR-0011 声称结构性关掉的"第一轮决策空工具表"对原生插件实际还开着。C1 的工具发现面因此无从验收——**本切片必须先修（§4）**。
- **F5 插件包零依赖零 import**：扫描判据 B4-deps 命中任何非空 `dependencies`/`devDependencies`/`peerDependencies`（含 `@keel/*`）→ 插件源码不 import 任何模块，`CellTool` 形状靠结构类型内联满足；echo 天然满足（无 IO、不用 `ctx.client`）。

## 3. 决策记录（所有者确认，2026-11-03）

| #   | 决策                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 缺口修复 = 默认入口 `main.ts` 补"本地占位 + `client.registerTool` 发布"，与承接层 cell-port 同形（备选"插件自带 cell-entry"——每插件重复装配逻辑；"宿主侧拉清单写分区"——绕开 AUTH 裁决 = 发明旁路；均否决） |
| D2  | 不新增 ADR：既有通道补齐 + ADR-0011 追加带日期实施注记（§4.3）                                                                                                                                             |
| D3  | 集成测试落点 = 根 `tests/native-echo-e2e.test.ts`（真进程集中根 tests/ 约定）+ 包内轻量单测                                                                                                                |
| D4  | 基准复采（插件自身开销，只测量不设阈值）= 切片④三件套齐后统一采，本稿只登记（§8）                                                                                                                          |
| D5  | `REVIEW.md` 切片②收尾即写（插件 A 随切片②转正）                                                                                                                                                            |

## 4. 内核补齐：默认入口的静态工具发布（先于插件实现）

### 4.1 设计

`packages/cell-runtime/src/main.ts` 装载序列改为（门内完成，之后才 `markReady()`）：

1. **本地占位**：`cell.registerTool(tool)`（`tool.exec` 的执行依据；现状已有）；
2. **分区发布**：按**声明顺序**逐个 `await cell.client.registerTool(tool.name, tool.schema ?? null)`——宿主侧完成 AUTH 裁决（`manifestAuthRules` 编译的 `tool.register` 规则）+ scope 分区写 + 挂起 `TOOL_SCHEMA_CHANGED`（run 首轮入账）；
3. 全部成功 → `markReady()` 开闸。

**失败语义：任一发布失败 = 进程 crash（非零退出）**，不回滚、不续装——本地表随进程消亡，无需承接层式的精细回滚（那里进程活着才需要）；stderr 带工具名与错误码；宿主侧表现为就绪探测失败（通道断 → `TRANSPORT/BADFRAME`，等不到 → `TRANSPORT/TIMEOUT`），与"舱内崩溃必须可见于退出分类"一致——**可见失败优于静默降级**（装载门设计初衷）。机制可行性：门不挡出向往返（F2）；宿主接线无竞态窗口（F3）；拒绝规则来源 = `manifestAuthRules(manifest, subject)`（宿主装配策略时编译，契约既有路径）。

> 已知边界（登记不扩范围）：发布失败时 `wireCell` 已 `alloc` 的分区不回收（既有行为，非本切片引入）；E4 负例用独立 scope 规避残留干扰。

### 4.2 由此解锁的负路径（manifest 语义第一次有真进程证据）

`tool.provide` 的 `allow` 收窄 vs 代码清单不一致：manifest 带 `allow: ["other-*"]` 而插件声明 `echo` → 发布被 AUTH 拒 → 舱 crash → `wireCell` 可见失败。"报关单是工具可见的唯一来源"（C1）自此在装载期也有印证。

### 4.3 ADR-0011 实施注记（带日期，D2）

> 实施注记（2026-11-03，Phase 3 切片②）：装载义务的"静态工具登记"明确为两件事——本地执行表登记**和**宿主侧分区发布（经既有 op `tool.register`，ADR-0010 通道；两步式与承接层 cell-port 同形）。默认入口在两者完成后才 `markReady()`；任一发布失败 = 进程 crash（可见失败）。门机制与就绪凭据不变（仍是单次 `cell.snapshot` 应答）——本注记只补全"装载完成"的定义。背景：原生插件首次落地，发现静态工具原先只进本地表、决策输入不可见（03 稿 F4）。

### 4.4 复现测试先行（standards/05）

e2e 测试先于 `main.ts` 修改存在：发现面断言（echo 出现在决策输入工具表）在补丁前必红（现状 = 空表）、补丁后转绿——红测先行与切片①同规。

### 4.5 实现期注记（2026-11-03，施工实测的集成面）

发布一通，"宿主必须编译报关单规则"从约定变成**硬前提**——凡装配默认入口舱的路径都在爆半径内，本切片一并落地：

- **CLI（apps/keel）**：`runPolicy` 拆出多舱合并版 `runPolicyFor`；`scenario` a2/a3/a4（withRuntime 增 policy 位）、`hotswap`（bind 前 v1 编译进 buildRuntime）、`recover`（runPolicy(manifest, oldRef.agentId)）、`bench` B3（改走 `wireCell`——裸 `spawnCell` 没人应答发布请求，且收敛点本就含就绪凭据）五处调用点补编译。
- **装配次序硬约束提前**：`spawnCell` 之后、**任何 await 之前**必须挂好 `serveCellChannel` + `ctx.alloc`（装载期发布是 Cell→宿主请求；晚一拍 = `no serve handler` → 舱装载即死）。踩实的一处：恢复路径里 `await cell.migrate()` 曾插在 spawn 与 serve 之间（旧行为装载期零 Cell→宿主请求，无害）——已改为 serve/alloc 先行、migrate 排门后。
- **两个被本改动炸出来的 rig 潜伏缺陷**（根 tests/ 不进类型检查的既有缺口所掩盖）：`serveCellChannel` 漏传第三参 deps（cell-crash）、deps 残缺只传 `{ledger, tracker}`（cell-crash-recovery / tool-failure-compensation 主舱与动作舱）——发布请求走到 `deps.auth` 即 TypeError。均已补全量 deps。
- **测试期望适配**：凡有 tools 导出 fixture 的 rig，策略补 register/remove 规则（与无 allow 报关单编译面等价）；concurrent（A1 一票否决承载）boot 状态多了静态发布一笔——boot 注册前**等待发布落进本 scope 分区**（消除发布/boot 竞态，P-006），指纹与 `TOOL_SCHEMA_CHANGED` 计数按新 boot 状态重算（静态 3 / 动态 6，ok 版本 v2 起）。
- **扫描器载体收窄**见 [02 稿 §7 注记](02-review-mechanization.md)（test/ 排除，非符号豁免）。

## 5. 插件 A 形状定案

### 5.1 目录与构建

```text
packages/plugins/echo/
├── keel-plugin.json                 # manifest（报关单本体）
├── package.json                     # @keel/plugin-echo；private；零依赖字段（B4-deps）
├── tsconfig.json / tsconfig.build.json
├── src/index.ts                     # 唯一实现文件（零 import）
├── test/echo.test.ts                # 轻量单测（handler 直测，零进程）
└── REVIEW.md                        # 留痕（D5：切片②收尾写）
```

`dist/` 不入库（.gitignore 既有）；workspace 纳管需在 `pnpm-workspace.yaml` 增一行 `packages/plugins/*`（实现注记，2026-11-03：§5.1 初稿称"零根配置改动"有误——既有通配 `packages/*` 是单层，盖不住嵌套的 `plugins/<name>`；除此一行外 root 配置零改动）。集成测试经 `pluginPath` 指向 `dist/index.js`，不 import 本包。

### 5.2 manifest（`keel-plugin.json`）

```json
{
  "kind": "capability",
  "meta": {
    "name": "echo",
    "version": "1.0.0",
    "title": "Echo",
    "description": "只读工具：原样返回输入文本（Phase 3 三件套插件 A）"
  },
  "permissions": [{ "cap": "tool.provide", "reason": "提供单个只读工具 echo，验证授权与工具发现" }],
  "resources": { "toolCallTimeoutMs": 10000 },
  "compensation": { "templates": [] },
  "compat": { "keelContract": "^1.0" }
}
```

无越界能力 → 空补偿模板合法（F1）；`reason` 附审计归因（manifest 稿 §5.2 建议）；allow 缺省 `*`（工具清单在代码内）。

### 5.3 模块导出面（`src/index.ts`）

```ts
// 零 import（F5）；CellTool 形状按结构满足，类型定义持于宿主入口（main.ts）
export const tools = [
  {
    name: "echo",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    handler: (params: unknown) => ({ echoed: (params as { text: string }).text }),
  },
];
```

一个工具、原样返回、无 IO、不调模型、不注册第二个工具（需求卡范围）；`{echoed}` 返回形与既有 `TOOL_RESULT.resultDigest` 断言形状一致（A1 测试同形）。无 `snapshot`/`compensations`/`migrate` 导出 = 无状态 Cell（契约既有口径）。

## 6. 真进程验收剧本（`tests/native-echo-e2e.test.ts`；锚 C1【一票否决】/C5/C6）

> 装配一律 `Assembler` 五步 + `wireCell()`（就绪凭据 = 探测应答，零豁免）；run 一律真实子进程；断言锚账本。

| 用例          | 场景与断言                                                                                                                                                                                                                                                                                                                                                                 | 锚          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| E1 装配与发现 | A/B 两 scope：A 装 echo，B = 对照舱（无 `tool.provide` 的 fixture，表恒空）。A 的 `TOOL_SCHEMA_CHANGED` 恰 1 条、`affectedScope` = A scope、run 首轮入账；A 决策输入工具表 = `[echo@1]` 恰一条；B 表恒空且 echo 零出现。同名舱下"互不可见"的机械表达 = 各自表恰好等于自身清单 + 变更事件归属纯净；全部事件 `runId`/`sessionId` 归属纯净，`ASSEMBLY_RECORDED` 为 run 首事件 | C1（I1/I5） |
| E2 主场景 run | A run 的 driver 决策调 `echo` → `TOOL_INVOKE`/`TOOL_RESULT` 落账本，`resultDigest.echoed` 与输入一致；run 收束 `halted`                                                                                                                                                                                                                                                    | C1          |
| E3 越权调用   | 无 `tool.invoke` 规则的主体发起调用 → 调度器当场拒：`AUTH_DENIED` 落账本（Authorizer 拒绝必写）+ `TOOL_RESULT{status:"error"}` 统一落点                                                                                                                                                                                                                                    | C1（I1）    |
| E4 装载期拒绝 | manifest 副本 allow 收窄 `["other-*"]` → echo 发布被拒 → 舱 crash → `wireCell` 可见失败（BADFRAME/TIMEOUT）；被拒路径无部分生效                                                                                                                                                                                                                                            | C1（§4.2）  |
| E5 崩溃半径   | 两 scope 各起 echo run；A 舱 `kill()`（在途打断唯一原语，P-010）→ A run 经既有 abort 路径落终态；B run 继续收束 `halted`、账本归属纯净无 A 污染                                                                                                                                                                                                                            | C5（I2）    |
| E6 决策重放   | A run 决策序列从账本重放（throughSeq 语义：每轮决策依据 = `DECISION.basedOn`，上界 = `throughSeq` 之前一切），逐轮输入/动作与 driver 剧本一致——形状对齐既有 `audit-attribution-replay.test.ts` / `decision-through-seq.test.ts`                                                                                                                                            | C6（I1/V6） |

**C6 切片②口径**：C6 全文含"含策略介入的归因"——策略介入是切片③ C4 的素材；切片②交付 echo run（无策略介入）的重放主干，切片③在 C4 用例中补策略归因复演。

红线：看真实退出码（`> log 2>&1; echo EXIT=$?`，P-005）；终态是第一条断言（P-008）；绿色当场验真（P-007）；真实子进程测试轮号非稳定量（P-006）。

## 7. 留痕与扫描面（02 稿 §5 口径，D5）

- `packages/plugins/echo/REVIEW.md` 五段模板，切片②收尾一次性写：① manifest 摘录（能力/资源/补偿三项）；② 01 清单 18 行逐条"不适用 + 一句理由"；③ 看代码三件事结论（入口形状 = `tools` 导出 / 工具体字段 / import 清单零三方）；④ 门禁与 E1~E6 退出码证据；⑤ D5 不可观察面清单（echo 无观察面，如实登记）。
- **措辞纪律**：REVIEW.md 引反面教材用行号（如"B2 行"），不抄判据串——C4 判据（`cordis.patch`/`patch.yml`/`dsh.`）扫全部文件含 md，抄词即命中（扫描器故意过收、无豁免通道）。
- 扫描面核对：echo 源码零禁面符号（无 `systemPrompt`/`budget`/`sessionId`/`exec.agent`/`timeoutMs` 等可调度量词、无白名单外 import）；`tests/native-plugin-scan.test.ts` 实扫组对本包自动生效（目录从占位变实体，实扫继续零命中 = C2 持续证据）。

## 8. 基准复采登记（D4）

echo 单工具调用自身开销（通道往返 + handler，只测量不设阈值）随切片④三件套齐后统一采、写阶段报告——本切片不采，避免单件数字先行。

## 9. 自检清单

**五大不变量对照**：

- **I1 控制不可旁路**：manifest 五步零豁免（E1）；装载期注册经 AUTH 裁决（E4）；运行期调用经调度器授权器，拒绝必留痕（E3）。
- **I2 故障不可级联**：`toolCallTimeoutMs` 硬强制既有；舱 crash 半径 = 单 Cell（E5）。
- **I3 状态不可丢失**：semver 精确 + `^1.0` 契约协商（§5.2）；发布顺序 = 声明顺序，装配可复现（§4.1）；无状态 Cell 无快照义务（§5.3）。
- **I4 副作用不可无痕**：echo 无副作用、零模板合法（F1）；主场景全程事件留痕，`EFFECT_DECLARED` 零出现即其负形证明（E2）。
- **I5 上下文不可全局污染**：分区 scope 键控、变更事件归属纯净（E1）；无全局注册表突变——发布走分区写、装配走作用域绑定（F3）。

**验收锚映射**：C1 = E1+E2+E3+E4；C5 = E5；C6 = E6（切片②主干）。C2/C7 由既有门禁持续覆盖（扫描实扫组 + 六道门禁），非本切片新增。

**铁律对照**：文档先行（本稿先于实现）；复现测试先行（§4.4：发现面断言先红后绿）；范围纪律（只做插件 A + F4 补齐；插件 B/C 属切片③）。

**体量自查**：插件实现 1 文件 + manifest 1 件；内核改动 1 文件（`main.ts`）；测试 = 1 集成文件 + 1 单测文件 + 1 对照 fixture；docs 净增 1 稿 + ADR-0011 注记 1 段 + 登记行。
