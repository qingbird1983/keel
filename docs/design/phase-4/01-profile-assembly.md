# Phase 4 切片①设计稿 01：Profile 装配面（一份装配清单拉起全家桶）

- 状态：**草稿**（待所有者评审——第二道闸；过闸后转定稿方可开工切片②）
- 日期：2026-11-04
- 关联：[phase-4 合同](../roadmap/phase-4-profile-engine-loop.md) §1/§2/§5 D1/§9 切片②；[manifest 规范](../design/phase-1/03-plugin-manifest.md)（五步校验，本稿零豁免复用）；[契约 §4.1/§5](../design/phase-1/01-core-api-contract.md)（`ASSEMBLY_RECORDED`）；[ADR-0011](../adr/ADR-0011-cell-load-gate.md)（就绪凭据）；[ADR-0012](../adr/ADR-0012-policy-plugin-process-and-hook-op.md)（策略舱与整份拒绝）；[ADR-0019](../adr/ADR-0019-trust-tiers-and-cell-isolation.md)（信任申请/授予）；[ADR-0021](../adr/ADR-0021-session-ledger-topology.md)（拓扑，K3 待拍板，不影响本稿）

## 1. 本设计稿回答什么

**一个 `profile.yaml` 如何把 engine + model + capability + policy 拉起、每个插件进哪种隔离环境、装配记录怎么写、失败时谁收尸。** 不含：engine 循环内部、模型调用协议、会话投影（各自的设计稿）。

## 2. 事实对账（写作前先核实现状）

- **F1 今天是"一 run 一 manifest"**：`assembleManifest` = 单份五步校验（`apps/keel/src/runtime.ts:85-87`）；`wireRun` 收单个 manifest + 单个插件路径（`runtime.ts:402-435`）。
- **F2 五步校验已就位且是纯函数**：结构 → 权限交叉 → 资源 → 版本 → 装配记录载荷（`packages/host/src/assembler.ts:139-268`）；产物 `LoadedManifest` 含 `record`（`161-175`）。**profile 不重写校验，只做多次调用 + 交叉校验**。
- **F3 多插件今天靠调用方约定拼**：策略按 `--policy-manifest/--policy-module` 成对多次传入（`apps/keel/src/cmd-run.ts:48-59`）；多舱授权规则合并点是 `runPolicyFor([...])`（`runtime.ts:148-164`）；策略舱"起舱 → 探就绪 → 整批注册"已有实现（`packages/host/src/policy-link.ts:69-153`）。
- **F4 `AssemblyManager` 是单 scope ↔ 单 manifest 的热换**（`packages/host/src/assembly-manager.ts:60-124`），不是"多插件清单"执行器——本稿不把它改成 profile 引擎（热换留后续，P12）。
- **F5 `kind` 今天只有三值**：`capability` / `policy` / `observation`（`docs/design/phase-1/schema/keel-plugin.schema.json:11-14`；代码 `assembler.ts:16-17`）；model/engine 两值由切片③④扩展（本稿只要求 profile 侧枚举提前认识五值）。
- **F6 零三方运行时依赖是基线**（`docs/standards/04-coding.md:73`）；仓库没有任何 YAML 解析器，现有 YAML 文件只有 pnpm 的锁与 workspace 清单。
- **F7 装配记录的既有口径**：`ASSEMBLY_RECORDED` 是该 run **首事件**，run 前失败的装配尝试不入账本（契约 §5 注记；`scheduler.ts:255`）。

## 3. 决策（P 编号；P1/P2/P4/P6 属需所有者确认项）

- **P1 文件与解析**：profile 是 `profile.yaml`（同时接受同构 `.json`）。YAML 解析用**仓库内严格子集**（块映射 / 块序列 / 标量 / 注释；**不支持**锚点、别名、多文档、flow 集合）。遇到不支持构造 → 显式报错并给行号，**绝不猜测或静默忽略**（YAML 的静默解析差异会把装配面变成隐患）。子集解析器 ~200 行、随包单测，不引三方依赖（F6）。
- **P2 分工**：profile = **清单**（哪个插件、用哪份报关单、用哪份模块、进哪个 scope）；manifest = **报关单**（权限/补偿/资源）。profile **不复制权限字段**（复制 = 两张皮，F3 的教训）；profile 里能写的只有装配位置类信息。
- **P3 交叉校验（防漂移）**：`profile.plugins[i].kind` 必须与所载 manifest 的 `kind` 相等，不等即拒绝；`id` 唯一、kebab-case；manifest/module 路径按 profile 文件所在目录解析（相对路径），绝对路径拒绝（可移植性 + 不写本机路径）。
- **P4 装配算法（一律 fail-closed，六步）**：
  1. 读文件 → 子集解析（P1）；
  2. profile schema 校验（未知字段拒绝）；
  3. 逐插件读 manifest → **五步校验零豁免**（F2）→ P3 交叉校验；
  4. 按 kind 分派隔离环境（P7）并拉起；Cell 类插件分配 scope（P8）；
  5. 逐 Cell 就绪凭据 = 一次 `cell.snapshot` 应答（沿用 ADR-0011，不新增 op）；
  6. 全部就绪后才注册 hook（复用 `wirePolicies` 的"整批注册"次序）并开放受理；`run.start` 时写装配记录（P6）。
- **P5 零加载保证**：装配只遍历 `plugins` 数组；`packages/plugins` 下未声明的包不扫描、不 import、不起进程。D1 的"未声明零加载"用**进程表 + 账本 + 模块加载探针**三重断言，不靠代码自觉。
- **P6 装配记录**：**逐插件一条** `ASSEMBLY_RECORDED`（合同 D1 原文），按声明次序写；载荷沿用既有规格，**追加两个可选字段**：`profile:{name, version}` 与 `plugin:{id}`。契约 §5 的"run 首事件"注记修订为"run 启动时按声明序写入的**首批**事件"（不新增事件类型；旧账本仍可读）。
- **P7 隔离环境分派**（K1/K2 的直接落地）：

  | kind | 运行环境 | 谁 spawn | 持密钥 | 账本记录 |
  | --- | --- | --- | --- | --- |
  | `capability` | Cell 进程 | `CellSupervisor` | 否 | 逐插件 `ASSEMBLY_RECORDED` |
  | `engine` | Cell 进程 | `CellSupervisor` | 否 | 同上 |
  | `policy` | 策略舱（独立进程，仅 `policy.hook`） | `wirePolicies` | 否 | 同上 + `policies` 摘要 |
  | `model` | Host 进程内模块 | profile 装配器直接构造 | **是**（per-request resolve，R5 地基） | 同上（`role:"model"`） |
  | `observation` | 无运行时（只读账本） | — | 否 | 同上 |

- **P8 scope 分配**：profile 可给顶层 `scope:{agentId?, sessionId?}`，缺省 `agentId = profile.name`、`sessionId = "main"`；单个插件可用 `scope` 覆盖。同一 scope 内工具可见性规则不变（`ToolCatalog` 既有语义）；跨 scope 互不可见由既有测试守住（D1 回归项）。
- **P9 包归属**：落在 `@keel/host`（`packages/host/src/profile/`：`parse.ts` 子集解析、`schema.ts` 校验、`assemble.ts` 编排）。**不新建 `packages/profile`**——一个装配面还撑不起一个包的生命周期，等它长出独立 API 面再拆（体量红线，standards/08）。
- **P10 CLI**：新增 `keel run --profile <file>`；`--manifest/--plugin` 单件路径**原样保留**（Phase 1~3 复演与测试依赖），二者互斥。`keel validate` 增加 `--profile` 形态（只校验不拉起，供 CI 用）。
- **P11 密钥红线**：profile 只允许写路径与引用名（`module`/`manifest`/`id`），schema `additionalProperties:false` 从结构上拒绝任何内联密钥；model 的密钥引用名写在**该插件自己的 manifest**里（`kind:"model"` 段，02 稿定），profile 不承载。
- **P12 热装配边界**：本阶段 profile 只在启动期装配一次；运行期换插件仍走 `AssemblyManager`（单 scope 单 manifest，F4）。"整份 profile 热换"记 backlog，不顺手做。

## 4. `profile.yaml` 形态（v1）

```yaml
version: 1
name: local-workspace
scope:            # 可选；下同
  agentId: local
  sessionId: main
plugins:
  - id: model-mock
    kind: model
    manifest: ./plugins/model-mock/manifest.json
    module: ./plugins/model-mock/dist/index.mjs
  - id: engine-react
    kind: engine
    manifest: ./plugins/engine-react/manifest.json
    module: ./plugins/engine-react/dist/index.mjs
  - id: fs-reader
    kind: capability
    manifest: ./plugins/fs-reader/manifest.json
    module: ./plugins/fs-reader/dist/index.mjs
  - id: danger-guard
    kind: policy
    manifest: ./plugins/danger-guard/manifest.json
    module: ./plugins/danger-guard/dist/index.mjs
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `version` | 是 | 目前仅 `1`；未知版本拒绝（不猜兼容） |
| `name` | 是 | kebab-case，作为缺省 `agentId` |
| `scope` | 否 | `{agentId?, sessionId?}`；缺省如上 |
| `plugins[].id` | 是 | kebab-case，清单内唯一 |
| `plugins[].kind` | 是 | 五值枚举；必须与 manifest 一致（P3） |
| `plugins[].manifest` | 是 | 相对路径，指向 JSON 报关单 |
| `plugins[].module` | 是 | 相对路径，指向已构建入口（`dist/`） |
| `plugins[].scope` | 否 | 覆盖顶层 scope |

Schema 文件：`docs/design/phase-4/schema/keel-profile.schema.json`（新目录，随本稿登记文档地图）。

## 5. 错误与失败语义

- 解析/校验/拉起任一步失败 = **整份拒绝**：已起的 Cell 全部 `drainAndReap`，hook 零注册，run 不启动，账本零事件（沿用 F7 口径）。
- 错误码**不新增**：复用 `SCHED/MANIFEST-INVALID`，`detail` 带 `{stage, pluginId, line?, cause}`。理由：错误码表是封闭集合（契约 §6），"装配清单不合法"与"报关单不合法"是同一准入类。若所有者要求 profile 独立码（`PROFILE/*`），按 ADR 另立。
- 部分成功不存在：不存在"三个插件起了、第四个失败还继续跑"的路径（与策略"整份拒绝"同一条纪律）。

## 6. 验收映射（D1）与红测先行

| D1 子项 | 机械断言 |
| --- | --- |
| 五步校验零豁免 | 用一份越界 manifest 混进 profile → 整份拒绝、零进程、零事件 |
| 逐插件隔离环境 | 进程表：capability/engine/policy = 子进程；model = 宿主内模块；无第三种 |
| 装配记录逐插件落账 | 账本按声明序出现 N 条 `ASSEMBLY_RECORDED`，`plugin.id` 齐全 |
| 未声明零加载 | 放一个"野生"插件目录不被 profile 引用 → 无进程、无 import、无事件 |
| 跨 scope 回归 | 两 scope 各一能力插件 → 互不可见（既有 C1 用例复用） |

红测先行：先写 `tests/profile-assembly-e2e.test.ts`（失败 → 实现 → 绿），至少覆盖上表五条 + 一条"路径为绝对路径即拒"。

## 7. 自检清单

- [ ] 没有把 manifest 的权限/补偿字段搬进 profile（P2）
- [ ] 解析器对不支持构造是硬失败，不是"尽量理解"（P1）
- [ ] 失败路径收尸完整：进程、hook 注册、账本三者都回到零（§5）
- [ ] 未新增事件类型、未新增错误码、未新增 op（契约封闭面）
- [ ] 未声明插件零加载有机械证据，不是注释（P5）
- [ ] 单件 `--manifest` 路径仍可用（P10 回归）

## 8. 待所有者拍板

- **P1**：接受 `profile.yaml` 的"严格 YAML 子集 + 零依赖解析器"，还是本阶段只收 `.json`（YAML 留到后续）？
- **P4**：六步顺序与"全部就绪才开放受理"是否照准。
- **P6**：装配记录改为"逐插件 N 条 + 两个追加字段"，是否照准（影响契约 §5 注记）。
