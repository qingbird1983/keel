# 插件 Manifest 设计（keel-plugin.json）

- 状态：定稿（2026-11-02 所有者确认；同日按所有者修复清单落实 A1~D3；切片③注记收口 N1~N5——§5.6/§6/§7/§11 + Schema 两处修订）

- 日期：2026-11-02

- 日期：2026-11-02

- 关联：[01-core-api-contract](01-core-api-contract.md)（§3.3 可见面矩阵、§4.8 hook 白名单）；[02-compensation-state-machine](02-compensation-state-machine.md)（§9 效果声明）；[ADR-0003](../../adr/ADR-0003-model-gateway.md)；[ADR-0005](../../adr/ADR-0005-cell-isolation.md)；standards/06 §4；[phase-0](../../roadmap/phase-0-design-baseline.md)（验收 A5）

## 1. 背景

DSH 症状 V5（热插拔依赖全局注册表突变）的根源：插件进入系统没有"报关单"——能力、权限、资源、收尾责任全靠运行时行为即兴呈现。本文定义插件的声明式入口 **manifest**：装配前静态校验，校验不过 = 不存在。设计简报四要素为硬约束：**权限声明、资源需求、补偿语义、版本约束**缺一不可。

设计输入（所有者已确认，2026-11-02）：

- **C-D1 权限粒度**：封闭能力词表 + 每项资源限定符，未声明 = 拒绝装配（fail-closed）。

- **C-D2 版本策略**：自身 semver 精确版本 + 宿主契约版本范围；可选 migration 迁移钩（新 Cell 内执行，失败回退）。

- **C-D3 资源强制**：工具调用超时必填且硬强制；内存/调用数上限声明先行、强制渐进。

## 2. 目标与不覆盖

**覆盖**：manifest 结构与 JSON Schema；权限词表首版；补偿模板制；版本与迁移语义；装配器五步校验；热装配切换时序；两个过审示例。

**不覆盖**：运行时授权执行（契约 §4.2 授权器）；补偿执行（状态机）；Cordis 存量插件的合成 manifest（Phase 2 Adapter）；观测插件的订阅语义细节（MVP 只保留 schema 位置）。

## 3. 决策记录

| #    | 决策                                                                                                      | 来源               |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------ |
| C-D1 | 封闭能力词表（6 项首版）+ allow 限定符；词表新增须 ADR                                                    | 所有者确认         |
| C-D2 | semver 精确版本 + `compat.keelContract` 范围 + 可选 migration                                             | 所有者确认         |
| C-D3 | `toolCallTimeoutMs` 必填硬强制；其余资源维度渐进                                                          | 所有者确认         |
| C-M1 | 补偿模板制：运行时 `EFFECT_DECLARED` 必须引用 manifest 已声明模板，临场编造即拒绝                         | 本文（焊死任务 D） |
| C-M2 | Schema = draft 2020-12；文件 `schema/keel-plugin.schema.json`；结构校验（Schema）与语义校验（装配器）分层 | 本文               |
| C-M3 | fail-closed：任一校验失败拒绝装配；未声明的能力不存在                                                     | standards/06 §4    |

## 4. Manifest 结构总览

| 节              | 必填               | 内容                                                                                                                    | 约束来源                |               |                  |
| --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------- | ---------------- |
| `kind`          | ✅                 | `capability`                                                                                                            | `policy`                | `observation` | 条件分支（§5.6） |
| `meta`          | ✅                 | name / version（semver 精确）/ title / description                                                                      | Schema                  |               |                  |
| `permissions`   | ✅                 | 能力词表项 + allow 限定符                                                                                               | C-D1；词表见 §5.2       |               |                  |
| `resources`     | ✅                 | toolCallTimeoutMs（capability 必填）/ memoryMbSoft / maxToolCallsPerRound；**policy/observation 必须为空对象** **`{}`** | C-D3                    |               |                  |
| `compensation`  | ✅                 | templates\[]（kind → class/action/idempotency/probe）                                                                   | C-M1；语义对齐状态机 §9 |               |                  |
| `compat`        | ✅                 | keelContract 版本范围                                                                                                   | C-D2                    |               |                  |
| `migration`     | 可选               | from 范围 + steps\[]（有状态插件升级迁移）                                                                              | C-D2；执行者见 §5.5     |               |                  |
| `hooks`         | policy 必填        | 契约 §4.8 四 hook 的非空子集                                                                                            | 契约白名单              |               |                  |
| `subscriptions` | observation 必填   | 只读事件订阅模式列表                                                                                                    | 契约 §3.3               |               |                  |
| `governance`    | 可选（capability） | tools\[]（工具 → guard / effects 切面绑定）；2026-11-03 追加                                                            | ADR-0015；§5.7          |               |                  |
| `trust`         | 可选（capability） | `{rawIo?: boolean}`——manifest 申请、宿主授予；默认拒绝；2026-11-03 追加（R5）                                           | ADR-0019；§5.8          |               |                  |

## 5. 各节详解

### 5.2 permissions（C-D1）

首版能力词表（**封闭**，新增须 ADR）：

| cap              | 语义                                 | allow 限定                                     | 补偿完备性要求 |
| ---------------- | ------------------------------------ | ---------------------------------------------- | -------------- |
| `tool.provide`   | 向本 Cell 私有工具表提供工具         | —（工具清单在代码内）                          | —              |
| `model.adapter`  | 模型适配（无凭证、无直连，ADR-0003） | —                                              | —              |
| `net.fetch`      | 出站网络                             | **必填**：主机名列表（精确或 `*.domain` 前缀） | templates 非空 |
| `fs.read`        | 读文件系统                           | **必填**：路径 glob                            | —              |
| `fs.write`       | 写文件系统                           | **必填**：路径 glob                            | templates 非空 |
| `memory.backend` | 提供私有记忆后端                     | —                                              | templates 非空 |

规则：未声明 = 不存在；`net.fetch`/`fs.write`/`memory.backend`（越界能力）必须携带 ≥1 条补偿模板（语义校验，装配器执行）；每项权限建议附 `reason`（审计归因）。

allow 的必填性由装配器语义校验执行，Schema 层不强制——这是结构校验与语义校验分层的设计选择（C-M2），不是 Schema 遗漏。

> 实现注记（2026-11-03 Phase 2 切片①，[ADR-0010](../../adr/ADR-0010-runtime-tool-registration-channel.md)）：词表**不增项**，`tool.provide` 的语义从"装载期代码内清单"扩到"运行期可注册/撤名"（跨通道 op `tool.register`/`tool.remove`，契约 §4.6）。本项 `allow` 由"不需要"变为"**可选收窄**"：缺省 = `*`（清单在代码内），给出 `allow` 则按 glob 限定可注册的工具名。同时明确：**词表项若无对应运行期 op 就不产出授权规则**（`memory.backend` 当前即如此）——声明不等于能力，运行期裁决只认有通道的项；把 manifest 声明编译成规则的动作在宿主（`permission-rules`），完整的"从运行观察合成声明"仍是 Phase 2 切片②。

### 5.3 resources（C-D3）

- `toolCallTimeoutMs`：capability 必填；硬强制——超时即按契约 §6 `TRANSPORT/TIMEOUT` 处理（结果未知 → 补偿核对路径），并作为 ADR-0005 `killed` 强杀的计时依据。

- `memoryMbSoft` / `maxToolCallsPerRound`：装配期静态校验 + 运行时软限（超限告警）；硬强制待 Phase 1 资源计量基建后回评（待决 §12）。

数值上限一览（与 Schema 现值一致）：

| 字段                 | Schema 上限 | 来源                     | 备注                                                                                                 |
| -------------------- | ----------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| toolCallTimeoutMs    | 600000      | 所有者确认（2026-11-02） | 契约 §7 管核心接口交互超时，工具执行超时按设计由 manifest 声明，无冲突；若有冲突以契约 §7 为准并回填 |
| memoryMbSoft         | 4096        | 所有者确认（2026-11-02） | 软限，硬强制待 Phase 1 资源计量                                                                      |
| maxToolCallsPerRound | 1000        | 所有者确认（2026-11-02） | 软限                                                                                                 |

### 5.4 compensation（C-M1，焊点）

- 模板字段与状态机 §9 效果声明一一对应：`kind`（效果种类）、`class`（三级分级）、`action`（plugin 内补偿动作引用或 builtin）、`idempotency`（natural/keyed/probe-guarded）、可选 `probe`。

- **运行时约束**：Cell 发起 `EFFECT_DECLARED` 时 `effectKind` 必须命中 manifest 模板——未声明的效果种类被 Core 拒绝，副作用无法发生。补偿因此**不可能被临场编造或省略**。

- `record-only` 申报显式入装配记录与账本（状态机 §7：申报压力设计）。

- 实现注记（2026-11-02 切片④）：`action.type:"plugin"` 的 `ref` 对应插件模块导出面 `export const compensations: Record<actionRef, handler>`——宿主补偿执行器经**一次性新补偿 Cell 进程**分发 `compensation.exec{actionRef, effectId, targetSummary, paramsDigest, phase:"undo"|"probe"}`（ADR-0005「新 Cell」路径，不依赖故障 Cell 存活）；未知 actionRef 拒绝。`record-only` 无需进程通道，执行器直闭（COMPENSATION\_EXECUTED{recordOnly} + 告警缝）。

- 2026-11-03 修订（[ADR-0016](../../adr/ADR-0016-builtin-compensation-registry.md)）：`record-only` 模板可省略 `action` / `idempotency`（装配器归一为 `builtin/record-only` + `natural`）；其余分级仍必填（Schema `if/then`）。`action.type:"builtin"` 由**宿主内建注册表**执行（首版闭集 `fs.remove`），不 spawn 补偿 Cell；`EFFECT_DECLARED.compensation.actionType` 标注 `plugin` / `builtin`（旧账本缺失按 `plugin` 读）。

### 5.5 compat + migration（C-D2）

- `compat.keelContract`：semver 范围（如 `^1.0`），必须包含当前 Core 契约版本，否则拒绝装配——宿主升级与插件兼容显式协商，不靠漂移。

- `migration`（可选，有状态插件专用）：`{ from: "<semver-range>", steps: [{ to, action: { type: "hook", ref } }] }`。

- 迁移执行者（回应设计简报遗留 S6）：**Supervisor 在新 Cell 内、快照挂载后首轮前**调用迁移钩；入参 = 旧版本状态快照，出参 = 新版本状态。迁移失败 → 新 Cell 丢弃、旧作用域继续服务（回退，V5）。无 `migration` 节 = 插件声明跨版本无状态，升级时快照不迁移（结构不兼容直接拒绝装配）。

迁移钩由 Supervisor 经 Core 结构化请求通道调用，在新 Cell 内、快照挂载后首轮前执行；执行结果入账本。迁移钩不直接访问旧 Cell 或外部网络，仅通过 Cell 内声明的能力接口操作。

实现注记（2026-11-02 切片④）：插件模块可选导出面与快照链路——`export async function migrate(oldState)`（升级迁移与恢复挂载共用通道：恢复时入参 = 最近快照，契约 §4.5 切片④注记）+ `export function snapshot()`（宿主经私有 op `cell.snapshot` 于轮边界索取私有状态，无此导出 = 无状态 Cell，不写 STATE\_SNAPSHOT\_REF）。快照内容宿主内存持有（D3），账本仅 `STATE_SNAPSHOT_REF{ref, version, round}` 元数据。

### 5.6 kind 条件分支（Schema allOf/if-then）

- capability：`resources.toolCallTimeoutMs` 必填；禁 `hooks`；

- policy：`hooks` 必填非空（白名单子集）；`permissions` 必须为空数组（策略插件只插话，不持能力）；`compensation.templates` 必须为空数组、禁 `migration`（策略插件不产副作用、无状态可迁移——2026-11-02 切片③收口 N1/N4）；

- observation：`subscriptions` 必填非空；`permissions` 必须为空数组（只读，契约 §3.3）；禁 `migration`（同上）。
- capability 的 `governance` 可选；policy / observation 出现 `governance` 即拒（`maxProperties: 0`）。
- capability 的 `trust` 可选；policy / observation 出现 `trust` 即拒（`maxProperties: 0`）。

### 5.7 governance（2026-11-03 追加，ADR-0015）

- 仅 capability；`tools[]` 每项 = `name`（工具名）+ 可选 `guard` + 可选 `effects[]`，至少一项非空。
- `guard = {cap: "fs.read"|"fs.write", from: "<params 顶层字段>", prefix?: string}`；`cap` 必须已在 `permissions` 声明且 `allow` 非空。守卫调用既有 `auth.check(cap, prefix + params[from])`，规则来源仍是 `manifestAuthRules`。
- `effects[] = {kind, targetFields[], digestFields?}`；`kind` 必须命中 `compensation.templates[].kind`；字段只支持顶层字段名，不支持表达式/嵌套路径；数组内不得重复。
- 宿主把本节编译为 `CellGovernancePlan`，经 `spawnCell` 的 `bootstrapExtra.governance` 随舱下发；**不进 `ASSEMBLY_RECORDED`**（同版本 manifest 可纯复算）。Cell 在 handler 前执行 `guard → effect.declare`，失败即 handler 不执行。
- 运行时字段缺失/类型不符 → `TRANSPORT/BADFRAME`；计划点名的工具未登记 → `markReady` 抛错（装载可见失败）。
- 2026-11-03 R3 注记（[ADR-0018](../../adr/ADR-0018-effect-receipts-and-workspace.md)）：`effects[].targetFields` 至少应包含 `path`（或工具实际写入的字段），handler 必须经 `ctx.workspace.create/overwrite` 写入；宿主按声明目标与实际目标的归一值比对，不一致 → `WORKSPACE/PATH`。直接 `fs.writeFile` 的 raw 写不会产生收据，`fs.remove` 不会删除它。

### 5.8 trust（2026-11-03 追加，ADR-0019）

- 仅 capability；形状 `{rawIo?: boolean}`。这是**申请**，不是授权。
- 宿主 `AssemblerOptions.allowRawIo` 默认 `false`：申请了 rawIo 但未授予 → 装配拒绝（`SCHED/MANIFEST-INVALID`），不把申请当授予。
- 授予后 `LoadedManifest.trust = "raw"`，并写入 `ASSEMBLY_RECORDED.trust`（缺省 = mediated，旧账本按 mediated 读）。
- raw IO 在当前进程后端**不被系统调用拦截**；它只是“显式受信 + 审计 + 不享受内置补偿”的标记。真正的隔离靠 Cell 进程 + 后续容器后端；Node 权限模型只作可选纵深防御。

## 6. 装配与校验流程（fail-closed，C-M3）

装配器五步（任一失败 = 拒绝装配，写 `SCHED/MANIFEST-INVALID`）：

1. **结构校验**：JSON Schema（draft 2020-12）；
2. **权限交叉校验**：越界能力（net.fetch/fs.write/memory.backend）allow 必填、补偿模板完备（§5.2 表）；
3. **资源校验**：toolCallTimeoutMs 在契约 §7 上限内；
4. **版本校验**：keelContract 范围含当前契约版本；升级场景另验 migration.from 匹配已装版本；
5. **记录**：装配清单入账本（权限、补偿 class、record-only 标记）——审计基线。

> 实现注记（2026-11-02 切片③，收口 N3）：第 5 步落地为账本事件 `ASSEMBLY_RECORDED`（契约 §5），由调度器在 `run.start` 时作为该 run 首事件写入；run 前失败的装配尝试不入账本（run-scoped 账本无宿主作用域），由装配器错误返回承载。

**热装配切换时序（V5 的正面表达）**：

```text
新版本 manifest → 五步校验 → 新 Cell spawn（IsolationProvider，ADR-0005）
  → context.alloc 新 scope → 迁移钩（如有，新 Cell 内）→ 原子作用域切换
  → 旧 Cell drain → reaped
任一步失败 → 新 Cell 丢弃，旧作用域不动（回退）
全程无全局注册表突变——被切换的是作用域绑定，账本逐事件留痕
```

## 7. Schema 文件与校验

- 位置：`docs/design/phase-1/schema/keel-plugin.schema.json`（draft 2020-12；`$id` = `https://keel.dev/schema/keel-plugin.schema.json`——占位标识 URI，不要求可解析；两示例 `$schema` 与之一致）；

- 示例：`schema/examples/capability-webfetch.json`、`schema/examples/policy-budget-guard.json`（验收 A5）；

- CI 义务（Phase 1 落地）：两示例必须过 Schema（示例即 fixtures，防 Schema 与文档漂移）；Schema 变更 = 契约语义级变更，走注记修订。

- 实现（2026-11-02 切片③）：校验由 host 装配器内置 draft 2020-12 关键词子集校验器执行（零运行时依赖；关键词封闭集合 = 本 Schema 实际使用者，Schema 修订须同步维护）；"两示例过 Schema"已入 host 测试。

## 8. 验收（对应 phase-0 A5、V5）

- [ ] **A5 结构**：两个示例通过 `keel-plugin.schema.json` 校验；schema 含权限/资源/补偿/版本四要素必填约束

- [ ] **A5 语义（负路径）**：缺 `net.fetch` allow、越界能力零补偿模板、policy 带 permissions、hook 名超出白名单——四类畸形 manifest 均被拒
  - 实现（2026-11-02 切片⑤）：四类负例实体化为外部 fixtures（`fixtures/manifest-negative/`，另加 2 枚结构负例），host 侧负路径组批量校验 + CLI `keel validate --dir` 复演——口径见 [04-cli-benchmarks-fixtures](04-cli-benchmarks-fixtures.md) §4

- [ ] **V5 升级回退**：migration 钩注入失败 → 新 Cell 丢弃、旧作用域继续服务、账本无全局突变痕迹（仅装配尝试事件）

- [ ] **C-M1 焊点**：运行时 `EFFECT_DECLARED` 引用未声明 effectKind → 拒绝且不留副作用

## 9. 自检清单（五大不变量对照）

- **I1**：manifest 是声明不是权力——hooks ∈ 契约白名单（§5.6）；运行时授权仍由授权器执行（§2）；

- **I2**：toolCallTimeoutMs 硬强制 + ADR-0005 killed 语义 = 单插件失控有界（§5.3）；

- **I3**：版本精确 + 契约范围 → 可复现装配；迁移失败回退，快照由 Host 持有（§5.5，D3 链路）；

- **I4**：越界能力强制补偿模板 + 运行时模板引用校验（C-M1）——补偿不可能被省略；

- **I5**：无全局注册表突变——热装配 = 作用域切换（§6）；observation 只读订阅（§5.6）。

## 10. 风险

| 风险                       | 预案                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| 词表膨胀压力               | 封闭词表 + 新增须 ADR（C-D1）；拒绝理由归因为装配审计事件              |
| Schema 与文档漂移          | 示例即 fixtures 入 CI（§7）                                            |
| Cordis 存量插件无 manifest | Phase 2 Adapter 合成 manifest（权限从运行观察收敛）；登记 Phase 2 待决 |
| 迁移钩成攻击面             | 迁移代码运行在新 Cell（隔离内）；失败即回退；入参仅快照                |

## 11. 待决问题

| 问题                                               | 决定时限                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `allow` 模式语法细节（fs glob 方言、域名通配边界） | Phase 1 实现期定稿并补测试                                                                                        |
| memoryMbSoft / maxToolCallsPerRound 硬强制时点     | Phase 1 资源计量基建后回评                                                                                        |
| migration 多步链（跨多版本升级）是否 MVP           | MVP 单步 from→current；多步登记 backlog                                                                           |
| 三个资源上限数值（600000 / 4096 / 1000）           | ✅ 已确认（2026-11-02）：维持现值                                                                                 |
| manifest 自身 schemaVersion 是否引入（N5）         | ✅ 已定案（2026-11-02 切片③）：不引入——`$id` + `compat.keelContract` 已锁定结构协商，漂移由五步校验第 1 步拦截    |
| `$id` 域名归属（keel.dev 占位，N2）                | ✅ 已定案（2026-11-02 切片③）：占位 URI 为 MVP 终态，代码从仓库路径加载 Schema，不按 URI 解析；真实域名延至发布期 |
