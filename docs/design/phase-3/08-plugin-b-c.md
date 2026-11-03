# Phase 3 切片④：插件 B（file-write）转正 + 插件 C（param-guard）

- 状态：**草案**（2026-11-04；提纲与 K1~K5 已由所有者确认，全文待评审转定稿——铁律 1）
- 日期：2026-11-04
- 关联：[02 稿](02-review-mechanization.md) §4（三件套需求卡，本稿唯一需求来源）；[05 稿](05-builtin-compensation.md)（builtin 补偿 + R3 收据注记）；[07 稿](07-runtime-context-refactor.md)（R1~R5 已落地底座）；[03 稿](03-plugin-a-echo.md)（插件 A 包形样板）；[01 清单](01-legacy-anti-patterns.md)（禁面）；[ADR-0015](../../adr/ADR-0015-manifest-governance-and-cell-aop.md) / [ADR-0016](../../adr/ADR-0016-builtin-compensation-registry.md) / [ADR-0018](../../adr/ADR-0018-effect-receipts-and-workspace.md) / [ADR-0020](../../adr/ADR-0020-workspace-error-codes.md)；[policy-link](../../../packages/host/src/policy-link.ts)（ADR-0012 装配链）
- DSH 症状锚：插件 B ↔ "卸载即无痕在越界副作用上失效"（01 清单 I 族）；插件 C ↔ "Agent Loop 被插件化导致控制流可被替换"（01 清单 A 族——策略只插话，不接管控制流）

## 1. 这份文档回答什么

切片③/③.5 已把机制建完（AOP 自动声明、builtin `fs.remove`、效果收据、受治理 Workspace、生命周期、隔离与信任）。切片④不再新建机制——它回答：**用这套底座"按规矩写的插件"最终长什么样**：

- 插件 B `file-write` 从 fixture 转正为 `packages/plugins/file-write/`，以**真进程补偿闭环**补 C3【一票否决】（越界写先声明 → 留痕 → 注入故障 → 补偿 → 回滚有账本证据；未声明的写当场拒绝、零部分生效）；
- 插件 C `param-guard` 新建为 `packages/plugins/param-guard/`，用既有策略链（ADR-0012）补 C4（危险参数被拦且介入可从账本归因；策略进程崩溃不级联）；
- 两份 `REVIEW.md` 留痕 + 禁面扫描零命中（C2）；六道门禁全绿（C7）。

## 2. 事实核对（写稿前逐条核实）

| #   | 事实                                                                                                                                                             | 含义                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| F1  | schema：`permissions[].cap` 承载 `fs.write` + `allow` 清单（`fs:` 前缀 glob）；没有 `paths.allow` 字段                                                           | 需求卡"paths.allow"是切片①的口语叫法，转正 manifest 按 schema 事实写（§9 口径修正）               |
| F2  | schema `kind:"policy"` 分支：`hooks` 必填且 ⊆ 四 hook 白名单；`permissions` / `resources` / `compensation` / `migration` / `governance` / `trust` 全部强制为空   | 策略报关单**只有 hooks 声明面**；"拟拦截的能力名"在 schema 上无位置，拦截规则只能归策略代码（K2） |
| F3  | 调度器把 `toolApproval` 入参 `{ tool, paramsDigest: action.params }` 发给 HookBus，经进程边界序列化到策略舱——`paramsDigest` 字段在 toolApproval 通道承载明文参数 | 策略进程可见参数明文，"内容模式"拦截可行（字段名沿用契约既有形状，不在本片改名）                  |
| F4  | deny 留痕：`deniedTool(h, action, "policy-hook", reason)` → `TOOL_RESULT{status:"error", error:{code:"AUTH/DENIED", by:"policy-hook", reason}}`                  | C4 归因的第一半凭据；第二半是介入 seq 进入后续 `DECISION.basedOn`                                 |
| F5  | hook 超时/抛错/舱退一律走内核既有 fallback 并落 `HOOK_VERDICT{fallback:true}`；不新增错误码；策略舱不 attachRun（退出不触发任何 run 的 abort）                   | C-E3 崩溃降级用例直接复用既有语义，零新机制                                                       |
| F6  | 扫描器缺省扫 `packages/plugins`；判据 B4-deps 禁**任何**依赖声明（含 `@keel/*` 类型 import）；echo 的先例：类型按结构满足，零 import                             | 转正件 .ts 的 `ctx`/hook 入参类型一律写本地结构类型，不 import 内核类型                           |
| F7  | `fs.remove` 只认 `EFFECT_SETTLED.receipt` 中 `created:true` 且 identity 复核通过的目标（05 稿 R3 注记）                                                          | C3 闭环的"补偿有据"一半；"未声明写当场拒绝"由 guard + 授权器承担                                  |
| F8  | `ctx.workspace.create` 用 `open("wx")` 独占创建并签发收据；已存在 → `WORKSPACE/EXISTS`（ADR-0020）                                                               | 转正件只做"新建"语义，与"补偿 = 删除本次创建的文件"自洽；覆盖写不进本件（K1/K5）                  |

## 3. 已拍板决策（2026-11-04 所有者确认）

| #   | 决策              | 落定值                                                                                                                                       |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | 插件 B 转正工具集 | **只有 `write_file`**（需求卡"一个工具"口径）；overwrite / 多 effect / env_probe 留在 fixture，其机制证据由 R1~R5 测试与 fixture 承担        |
| K2  | 插件 C 拦截规则   | **代码内硬编码**；manifest 声明面仅 `hooks`（F2 本就无声明位）；不引入规则/表达式语言                                                        |
| K3  | 插件 C 靶工具     | **联装拦转正插件 B 的 `write_file`**（C4 口径"对 write_file 类工具"；三件套叙事同装配）                                                      |
| K4  | fixture 去留      | **保留** `tests/fixtures/file-write-plugin`；分工：fixture = 切片③/③.5 机制样例，`packages/plugins/file-write` = 转正标杆（C3 以转正件为准） |
| K5  | 覆盖写补偿声明    | 转正件无覆盖写工具，无此问题；"覆盖写 → `record-only`/插件补偿"写进 §10 使用须知（`fs.remove` 不认覆盖写收据）                               |

## 4. 插件 B：`packages/plugins/file-write/`

### 4.1 目录与包形（对齐 echo 先例）

```text
packages/plugins/file-write/
  keel-plugin.json      # 报关单（§4.2）
  package.json          # @keel/plugin-file-write，private，零依赖（B4-deps）
  src/index.ts          # 纯 handler（§4.3），零 import（F6）
  test/file-write.test.ts
  tsconfig.json / tsconfig.build.json
  REVIEW.md             # 转正留痕（§8）
```

### 4.2 manifest 定稿

```json
{
  "kind": "capability",
  "meta": {
    "name": "file-write",
    "version": "1.0.0",
    "title": "File Write",
    "description": "越界工具标杆：受治理的新建写，补偿由底座按收据执行（Phase 3 三件套插件 B）"
  },
  "permissions": [
    { "cap": "tool.provide", "reason": "提供 write_file" },
    {
      "cap": "fs.write",
      "allow": ["fs:/tmp/keel-workspace/**"],
      "reason": "只写工作区；部署时按真实根目录替换"
    }
  ],
  "resources": { "toolCallTimeoutMs": 10000 },
  "compensation": {
    "templates": [
      {
        "kind": "fs.write.done",
        "class": "reversible",
        "action": { "type": "builtin", "ref": "fs.remove" },
        "idempotency": "natural"
      }
    ]
  },
  "governance": {
    "tools": [
      {
        "name": "write_file",
        "guard": { "cap": "fs.write", "from": "path", "prefix": "fs:" },
        "effects": [
          {
            "kind": "fs.write.done",
            "targetFields": ["path"],
            "digestFields": ["path", "content"]
          }
        ]
      }
    ]
  },
  "compat": { "keelContract": "^1.0" }
}
```

要点：

- `allow` 与 `governance.guard` 指同一能力面：授权器（宿主）与守卫（Cell）先后核对，两层都 fail-closed；
- 补偿模板 = builtin `fs.remove`：插件**零撤销代码**；执行时宿主只认收据（F7）；
- 不声明 `trust`（无 raw IO，黑路径不申请）。

### 4.3 handler（转正后全貌）

```ts
type WriteParams = { path: string; content: string };
type WorkspaceHandle = {
  create(args: { path: string; content: string }): Promise<{ bytes: number }>;
};

export const tools = [
  {
    name: "write_file",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (params: WriteParams, ctx: { workspace: WorkspaceHandle }) => {
      const r = await ctx.workspace.create({ path: params.path, content: params.content });
      return { path: params.path, bytes: r.bytes };
    },
  },
];
```

- 声明、守卫、补偿、收据全部在 manifest 与底座；handler 只剩参数与业务（07 稿 §3"安全路径最短"指标：工作区新建文件 = 1 个能力，handler ≤5 行业务，0 撤销代码，0 auth 调用）；
- 类型为本地结构类型，零 import（F6）；类型正确性由 e2e 真进程行为验真（P-007）。

## 5. C3 端到端用例集（转正件真进程，`tests/native-file-write-e2e.test.ts`）

> 装配方式沿用 `tests/native-file-write-aop.test.ts`（Assembler + CellSupervisor + wireCell + ProcessIsolationProvider）；报关单 = `packages/plugins/file-write/keel-plugin.json`，模块 = 其 `dist/index.js`；唯一测试期替换 = `fs.write.allow` 的工作区根（仓库件给范式路径，fixture 同例）。红测先行（铁律 7 / P-007）。

| #    | 场景               | 断言（全部锚账本与真文件系统）                                                                                                                                                                                                                                                                                        |
| ---- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-E1 | **补偿闭环主体**   | write_file 新建文件真实落盘 → 注入故障使 run 失败 → builtin `fs.remove` 执行 → **文件消失**；账本序完整：`ASSEMBLY_RECORDED` → `TOOL_INVOKE` → `EFFECT_DECLARED`（`compensation.actionType:"builtin"`）→ `EFFECT_SETTLED`（`receipt.created === true`，含 identity）→ `COMPENSATION_EXECUTED`（`removed` = 目标路径） |
| B-E2 | 越界拒、零部分生效 | `path` 不在 allow 清单 → handler **零执行**（文件不存在、无 `EFFECT_SETTLED`）；内核留 `AUTH_DENIED`（`fs.write`），工具结果 `AUTH/DENIED`                                                                                                                                                                            |
| B-E3 | 重试幂等           | 同 `toolCallId` 重试 → 复用既有收据、**不重复写**（R4 语义在转正件上验证一次）                                                                                                                                                                                                                                        |
| B-E4 | 状态可恢复（I3）   | B-E1 的账本含补偿候选投影所需的全部字段——补偿执行器**只读账本**即可找到目标（无内存态依赖）                                                                                                                                                                                                                           |

分工注记（K1/K4）：预存在文件不误删、覆盖写不进内建删除、多 effect 部分失败只补偿已发生、路径逃逸/身份不符拒绝——这些**机制证据**已在 `packages/host/test/workspace.test.ts` / `compensator.test.ts` 与 `tests/native-file-write-aop.test.ts`（fixture）锚定，转正件不重复铺开；C3 以转正件的 B-E1 闭环为准。

## 6. 插件 C：`packages/plugins/param-guard/`

### 6.1 目录与包形（同 §4.1，名换 param-guard）

包名 `@keel/plugin-param-guard`；`src/index.ts` 零 import；唯一导出 = `export const hooks`（四 hook 白名单口径：导出键集必须与报关单声明**完全相等**）。

### 6.2 manifest 定稿

```json
{
  "kind": "policy",
  "meta": {
    "name": "param-guard",
    "version": "1.0.0",
    "title": "Param Guard",
    "description": "策略插件：按参数内容模式否决 write_file 调用（Phase 3 三件套插件 C）"
  },
  "hooks": ["toolApproval"],
  "compat": { "keelContract": "^1.0" }
}
```

- schema 强制其余节为空（F2）——"拟拦截的能力名"没有声明位，拦截规则即代码（K2）；
- 只申领 `toolApproval`：未申领的插话点不注册、无事件（"无介入即无留痕"）。

### 6.3 拦截规则（代码内，guard 覆盖不到的面）

规则：对 `tool === "write_file"` 且 `params.content` 含子串 **`TOPSECRET`** 的调用 → `deny`，reason = `"policy: content matches blocked pattern TOPSECRET"`；其余一律放行。

- 选内容模式的理由（C4 注记）：装配 allow / governance guard 只看 `path`，**内容模式是它们结构上看不到的面**——避免把"策略拦截"与"守卫拒绝"混成一条证据；
- 策略不改写参数、不替插件重试、无任何自带 IO（需求卡"不做"三铁律）；deny 是它唯一的动作。

## 7. C4 端到端用例集（联装，`tests/native-param-guard-e2e.test.ts`）

> 联装 = 转正插件 B（工具舱）+ 插件 C（策略舱，`policy-link` 装配）同宿主；靶工具 = `write_file`（K3）。策略模块 = `packages/plugins/param-guard/dist/index.js`，报关单 = 其 `keel-plugin.json`。红测先行。

| #    | 场景           | 断言                                                                                                                                                                                                                                                                             |
| ---- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-E1 | 拦截 + 可归因  | content 含 `TOPSECRET` → `TOOL_RESULT{status:"error", error:{code:"AUTH/DENIED", by:"policy-hook", reason 含 "TOPSECRET"}}`；该轮介入的 `HOOK_CALLED` / `HOOK_VERDICT{verdict:"deny"}` seq 出现在后续 `DECISION.basedOn`；**handler 未执行**（文件不存在、无 `EFFECT_DECLARED`） |
| C-E2 | 放行不误伤     | 正常 content → `HOOK_VERDICT{verdict:"allow", fallback:false}`，文件落盘（联装成立：C 拦 B 只按规则，不波及正常写）                                                                                                                                                              |
| C-E3 | 崩溃降级（I2） | kill 策略舱进程 → 介入走既有 fallback：`HOOK_VERDICT{fallback:true}`，run 照常推进不崩（B7① 口径延续；策略舱不 attachRun，F5）                                                                                                                                                   |
| C-E4 | 无介入无事件   | 未申领的 `stopAdvice` / `retryAdvice` / `budgetExhaustedChoice` 零 `HOOK_CALLED`；`ASSEMBLY_RECORDED.policies` = `[{ name:"param-guard", version:"1.0.0", hooks:["toolApproval"] }]`                                                                                             |

## 8. 施工顺序与转正留痕

1. **本文定稿**（所有者评审通过）；
2. 插件 B：包骨架 → e2e 红测（B-E1~E4 先红）→ 实现（§4.2/4.3 本就已具备全部机制，红转绿）；
3. 插件 C：包骨架 → e2e 红测（C-E1~E4 先红）→ 实现；
4. 两份 `REVIEW.md`（02 稿 §5 五段模板）：manifest 摘录、01 清单 18 行逐条留痕、看代码三件事、门禁与真进程退出码证据、不可观察面清单；
5. 禁面扫描实扫零命中（`packages/plugins` 三件全扫）；C1~C7 复核留给切片⑤，本片只对账 C2/C3/C4/C7；
6. 收口四件事：CHANGELOG（新在前、非技术语）、看板、CONTEXT 重写、handoff 归档；坑当轮提取。

## 9. 与需求卡的口径修正登记（02 稿 §4 不改文本，差异在此对账）

| 需求卡原文（02 稿 §4）                      | 定稿口径                                                                                             | 缘由                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| "`paths.allow` 清单"                        | `permissions[fs.write].allow`（`fs:` 前缀 glob）                                                     | F1：schema 事实；需求卡写卡时用语不精确 |
| "补偿动作 = 删除该文件（可逆分级）"         | manifest 补偿模板 `builtin fs.remove`；宿主执行时**只认收据**（`created:true` + identity）           | ADR-0016/0018：先声明后动手 + 收据语义  |
| "manifest 声明面：……拟拦截的能力名"（C 卡） | 声明面仅 `hooks`；拦截规则在代码内                                                                   | F2：policy 分支 schema 强制其余节为空   |
| "如拒绝 `path` 越出清单"（C 卡示例）        | 换成内容模式 `TOPSECRET`（`path` 越界由 guard/授权器承担，C4 用例不得与守卫拒绝混同）                | C4 切片重排注记（02 稿 §4 插件 C 注记） |
| "一个工具 `write_file`"（B 卡）             | 转正件确实只有 `write_file`（K1）；fixture 的 overwrite / write_two / env_probe 是机制样例，不随转正 | K1/K4                                   |

## 10. 使用须知（写进插件 B 的 README 段与 REVIEW.md）

- `write_file` 只做**新建**：目标已存在 → `WORKSPACE/EXISTS`（ADR-0020），不覆盖；需要覆盖写时声明 `record-only` 或插件补偿（`fs.remove` 不认覆盖写收据，K5）；
- 直接 `fs.writeFile` 不产生收据：内置删除不会碰它，且受信面评审会挡（黑路径默认拒绝）；
- 收据 identity 含 `dev/ino/size/mtimeMs/sha256`：补偿前复核，不符 = 升级不删（0 误删目标）。

## 11. 自检清单

- **铁律 1**：本稿先于实现；K1~K5 已经两道闸第一道，全文待第二道。
- **铁律 5**：范围 = 转正 B + 新建 C + 留痕；规范回填/阶段报告/基准复采归切片⑤，不顺手做。
- **铁律 7**：B-E/C-E 用例先行（红）→ 实现 → 绿，证据链与 Phase 2 同规。
- **I1**：授权/账本/补偿触发全在宿主控制面；C 经 `toolApproval` 白名单插话，deny 亦由内核落账——策略只有否决权，没有控制权。
- **I2**：策略舱崩溃 → 既有 fallback（C-E3）；插件 B 失败 → 补偿按状态机，不级联 run。
- **I3**：B-E4：补偿候选与闭环证据全在账本，重放可复原决策序列。
- **I4**：越界写先声明（AOP 自动）→ `EFFECT_DECLARED` 先于任何 IO；未声明写（allow 外）当场拒绝零部分生效（B-E2）；builtin 只认收据（F7）。
- **I5**：无全局注册表；工具经装配进声明 scope，策略舱不见除入参外的任何会话态。
- **禁面**：转正件零 import（F6）、无 budget/sessionId/ctx.get 等符号；扫描器实扫负样本组照旧防假绿。
