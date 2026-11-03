# Phase 3 切片③方案：Cell-Runtime 治理切面（AOP）——让 handler 只剩纯业务

- 状态：**定稿**（2026-11-03 所有者要求“内置补偿 + 无感治理”后定稿；D1~D6 按建议列定案，配套 [05 内置补偿稿](05-builtin-compensation.md) 与 [ADR-0015](../../adr/ADR-0015-manifest-governance-and-cell-aop.md)）
- 日期：2026-11-03
- 关联：[phase-3 合同](../../roadmap/phase-3-native-ecosystem.md) §7（2026-11-03 修订：本稿为新增切片③）；[03 稿](03-plugin-a-echo.md)（插件 A 已落地）；[02 稿](02-review-mechanization.md)（插件 B/C 需求卡）；[manifest 稿](../phase-1/03-plugin-manifest.md)；[补偿状态机](../phase-1/02-compensation-state-machine.md) §9；[ADR-0005](../../adr/ADR-0005-cell-isolation.md) / [ADR-0010](../../adr/ADR-0010-runtime-tool-registration-channel.md) / [ADR-0011](../../adr/ADR-0011-cell-load-gate.md) / [ADR-0015](../../adr/ADR-0015-manifest-governance-and-cell-aop.md) / [ADR-0016](../../adr/ADR-0016-builtin-compensation-registry.md)

## 1. 这份文档回答什么

所有者观察到一个真实的开发体验问题：写一个有副作用的工具时，`handler` 必须接收 `ctx.client`，自己调 `authCheck`、自己算摘要、自己先调 `declareEffect`，然后才写业务——治理动作和业务代码搅在一起。所有者要求：

1. `handler` 保持绝对纯净（只处理参数和业务）；
2. 由 Cell-Runtime 按 Manifest 的声明，在框架层自动完成副作用声明（`EFFECT_DECLARED`）与治理参数传递；
3. 给出改造前后的对比示例；
4. 评估难度并更新 P3 切片计划。

本稿给出事实核对、方案、前后对比、难度评估与定案。**定稿后进入实现**；与之配套的“免写撤销代码”见 [05 内置补偿稿](05-builtin-compensation.md)。

## 2. 事实核对（开工前）

| #   | 事实                                                                                                                                                                                                                          | 对方案的含义                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| F1  | 当前 `CellTool.handler` 形状 = `(params, ctx: {client: CellClient})`；`client` 暴露 `authCheck` / `declareEffect` / `modelInvoke` / `ledgerRead` 等全部通道面（`packages/cell-runtime/src/cell.ts`）                          | 治理动作和业务能力混在同一个出口，插件作者只能靠自觉区分                                                                 |
| F2  | **manifest 只到宿主，不到插件进程**：`Supervisor.spawnCell` 给 Cell 的 bootstrap 只有 `{pluginPath, toolCallTimeoutMs}`（外加策略舱的 `hooks`）；`Assembler` 校验完的报关单留在宿主                                           | 这是胶水的根因——Cell 不知道自己被允许做什么、哪个工具对应哪个 effectKind，只能由作者把治理意图硬编码进 handler           |
| F3  | `effect.declare` 的语义：`effectKind` 必须命中 manifest 模板；`actionRef` / `idempotency` 由宿主按模板填，插件提交值不改变落账；`effectId` 由 Cell 侧 `crypto.randomUUID()` 生成；`targetSummary` / `paramsDigest` 由调用方给 | “自动声明”只需把 `kind + targetSummary + paramsDigest` 送过去；补偿动作与幂等口径本来就不归插件临场决定（C-M1 焊点不动） |
| F4  | `EFFECT_SETTLED` 由宿主在工具调用返回后按结果结算；未结效果窗口 = 当前工具调用（`packages/host/src/effects.ts`）                                                                                                              | “handler 之前声明、handler 之后由宿主结算”与现有窗口模型天然吻合，不需要改状态机                                         |
| F5  | `manifestAuthRules` 会把 `fs.write` 的 `allow` 编译成授权规则，但**本片之前没有任何运行期调用点**；`authCheck` 只有调用方显式调用才会发生                                                                                     | 边界能力的权限检查此前是“规则在库里、没人去问”；切片③补上第一个自动调用点（manifest `guard`）                            |
| F6  | `spawnCell` 已有 `bootstrapExtra` 追加字段的 seam（切片④为策略舱加 `hooks`），既有入口忽略未知字段                                                                                                                            | 治理计划可以走这条既有缝，**不新增通道 op**                                                                              |
| F7  | manifest Schema 顶层 `additionalProperties: false`；policy/observation 的 `if/then` 禁止额外能力面                                                                                                                            | 新增治理声明必须同步 Schema 与装配器语义校验，属于契约级变更（ADR）                                                      |
| F8  | Cordis 适配层仍在库（归档不删），其 `context.effects.declare` 映射 `cell.client.declareEffect`；插件 A `echo` 的 handler 已只收 `params`                                                                                      | 新机制必须对“没有治理计划的 Cell”与“只收 params 的 handler”保持兼容；Cordis 的手动声明不强行迁移                         |
| F9  | 原生插件零 import（扫描判据 B4-deps），不能用 TypeScript 装饰器/注解表达切面                                                                                                                                                  | 切面声明只能放在 **manifest**（报关单）里，由运行时织入——这正是 AOP 的“声明式 pointcut”形态，而非代码装饰器              |

## 3. 目标与非目标

**目标**

- handler 不出现 `authCheck` / `declareEffect` / 摘要计算 / 治理参数拼装；
- 一个工具的“查什么权限、声明什么副作用、摘要取哪些字段”完全由 manifest 声明；
- 治理在 handler **之前**完成，失败则 handler 不执行（fail-closed，符合“先声明后动手”）；
- 需要 effectId 做外部幂等的业务，能从只读上下文拿到框架已声明的 `effectId`；
- 对既有 echo / Cordis 适配层 / 动态注册工具零破坏；不新增通道 op、事件类型、错误码、依赖。

**非目标**

- 不是沙箱：handler 仍可直接 `import { writeFile } from "node:fs/promises"`；真正的边界是 Cell 进程隔离 + manifest 授权 + 人工评审，AOP 只是治理义务的“代劳层”；
- 不自动推断 effectKind（不做魔法命名/模式匹配）；
- 不接管策略 hook（插件 C 的 `policy.hook` 仍在宿主侧、先于 `tool.exec`）；
- 不在本片支持 `dependsOn` / `probe` / `retention` 的自动声明（留给有真实需求的后续 ADR）；
- 不改 Cordis 适配层的既有手动声明路径（归档件不动）。

## 4. 方案

### 4.1 总览

```mermaid
flowchart LR
  M[manifest.governance] --> C[宿主：五步校验 + 编译治理计划]
  C -->|bootstrapExtra.governance| S[Cell 启动]
  S --> R[tool.exec]
  R --> G{有治理计划?}
  G -- 否 --> H[handler(params) ── 老路径不变]
  G -- 是 --> A[auth.check 权限守卫]
  A -- 拒绝 --> E1[工具错误 AUTH/DENIED<br/>handler 不执行]
  A -- 通过 --> D[effect.declare（逐个声明）]
  D -- 拒绝/超时 --> E2[工具错误<br/>handler 不执行]
  D -- 成功 --> H2[handler(params, ctx.effects)]
  H2 --> X[宿主按结果结算 EFFECT_SETTLED]
```

一句话：**manifest 声明切点，宿主编译计划，Cell 在 handler 外面包一圈拦截器；handler 只留业务。**

### 4.2 manifest 新增 `governance` 节

顶层新增（字段名已定案，D1/D2）：

```json
"governance": {
  "tools": [
    {
      "name": "write_file",
      "guard": { "cap": "fs.write", "from": "path", "prefix": "fs:" },
      "effects": [
        {
          "kind": "file.write",
          "targetFields": ["path"],
          "digestFields": ["path", "content"]
        }
      ]
    }
  ]
}
```

语义：

- `tools[].name`：与插件导出的工具名一一对应；同一名下不得重复声明。
- `guard.cap`：只允许 `fs.read` / `fs.write`（D3：`net.fetch` 需要主机名归一，另案）；该 cap 必须已在 `permissions` 中声明，且必须有非空 `allow`（否则守卫必拒，装配期就应拦下）。
- `guard.from`：从 params 取哪个顶层字段拼资源；`guard.prefix` 缺省空串，**fs.\* 必须显式写 `fs:`**（不设魔法默认，写漏会被授权器拒绝——fail-closed）。守卫调用既有 `auth.check(cap, prefix + params[from])`，规则来源仍是 `manifestAuthRules`，**不复制授权逻辑到舱内**。字段值必须与 handler 实际使用的目标一致（建议绝对路径），否则会出现“守卫放行、业务写别处”的错位。
- `effects[].kind`：必须命中 `compensation.templates[].kind`（装配器语义校验；运行期内核仍会按 C-M1 再验一次）。
- `effects[].targetFields`：进入账本 `targetSummary` 的字段（**明文**，只放标识类字段）。
- `effects[].digestFields`：进入 `paramsDigest` 的字段（**只出摘要**，可含敏感内容）；缺省则 `paramsDigest = null`。
- 字段选择只支持**顶层字段名**（D2）；不引入 JSONPath/模板语言。插件 B 的 `{path, content}` 够用；将来确有嵌套需求再走 ADR。

Schema 约束要点（实施时同步 `keel-plugin.schema.json`；**只用校验器已支持的关键词**——不引入 `anyOf` / `uniqueItems` 等新词，避免“Schema 语义级变更 + 校验器扩表”两件事一起来）：

- `governance` 仅 capability 可用；policy/observation 出现即拒（`maxProperties: 0`）。
- `tools` 非空；每项 `name` 非空；`guard.cap` 为 `fs.read` / `fs.write`；`from` 非空；`prefix` 可选。
- `effects` 出现时非空；每项 `kind` 符合 effectKind 词法，`targetFields` 非空，`digestFields` 可选非空。
- 结构校验之外，装配器补语义校验：每项至少有一个 guard/effect、工具名唯一、`targetFields` / `digestFields` 去重、`kind` 命中模板、`guard.cap` 已在 permissions 且有非空 allow。
- **不**在装载期检查 `targetFields` / `digestFields` 是否出现在工具 Schema 的 `properties`（Schema 可能是 `$ref` / `allOf`，解析成本不成比例）；运行时缺字段即 `TRANSPORT/BADFRAME`，handler 不执行。

### 4.3 宿主侧：编译治理计划，走既有 bootstrapExtra

```ts
// packages/cell-runtime/src/governance.ts（类型由 Cell-Runtime 拥有，宿主只引用）
export interface CellGovernancePlan {
  version: 1;
  tools: Record<
    string,
    {
      guard?: { cap: string; from: string; prefix?: string };
      effects?: { kind: string; targetFields: string[]; digestFields?: string[] }[];
    }
  >;
}
```

- `Assembler` 在 `LoadedManifest` 上保留 `governance`（可选），完成五步校验与语义校验（工具名唯一、`kind` 命中模板、`guard.cap` 已声明且有 allow、无空条目）。
- 新增 `packages/host/src/governance.ts`：`compileGovernancePlan(manifest): CellGovernancePlan | null`——纯映射，负责补 `version`、去空项（不替作者补 `prefix`）。
- `SupervisedCell` 构造 bootstrap 时追加 `governance`（没有声明就不加），**不改既有载荷形状**；策略舱的 `hooks` 与能力舱的 `governance` 是同一 seam 的两个字段。
- **不把整份 manifest 塞进舱**：Cell 只需要执行所需的 guard/effect 映射；整份报关单留在宿主，减少舱内可篡改面与耦合，也避免 Cell 误用授权/补偿字段。
- 装配收敛点仍是 `wireCell`（spawn → serve → alloc → 就绪探测）；治理计划随 spawn 一次送达，不产生额外往返。
- `ASSEMBLY_RECORDED` **不追加** governance 摘要（避免事件契约变更）：manifest 版本已在记录中，`EFFECT_DECLARED` 自带 `kind` / `targetSummary`；计划可由同一版本 manifest 纯复算。

### 4.4 Cell 侧：拦截器链

`CellOptions` 新增可选 `governance?: CellGovernancePlan`；`main.ts` 从 bootstrap 读出后传入。`startCell` 的执行路径：

```ts
const governed = new Map(Object.entries(opts.governance?.tools ?? {}));

async function execTool(p: { tool: string; params?: unknown }): Promise<ToolExecResult> {
  const tool = tools.get(p.tool);
  if (!tool) return toolUnknown(p.tool);
  const plan = governed.get(p.tool);
  // 整个拦截器链都在 toolCallTimeoutMs 之内（超时语义不变）
  return hardTimeout(() => runGoverned(tool, plan, p.params), "CELL/TOOL-FAILED");
}

async function runGoverned(tool: CellTool, plan: GovernedToolPlan | undefined, params: unknown) {
  if (!plan) return tool.handler(params, { client, effects: EMPTY_EFFECTS }); // 老路径

  if (plan.guard) {
    const resource = guardResource(plan.guard, params); // 缺字段/非字符串 → TRANSPORT/BADFRAME
    const d = await client.authCheck(plan.guard.cap, resource);
    if (!d.allowed) {
      throw new ChannelError("AUTH/DENIED", `governance guard denied: ${plan.guard.cap}`, {
        cap: plan.guard.cap,
        resource,
        reason: d.reason,
      });
    }
  }

  const effects: DeclaredEffectView[] = [];
  for (const e of plan.effects ?? []) {
    const targetSummary = pickFields(params, e.targetFields, "effect target");
    const paramsDigest = e.digestFields
      ? canonicalDigest(pickFields(params, e.digestFields, "effect digest"))
      : undefined;
    const r = await client.declareEffect({
      effectKind: e.kind,
      targetSummary,
      compensation: paramsDigest ? { paramsDigest } : {},
    });
    effects.push({ kind: e.kind, effectId: r.effectId, seq: r.seq, targetSummary, paramsDigest });
  }

  return tool.handler(params, { client, effects: Object.freeze(effects.map(Object.freeze)) });
}
```

`markReady()` 增加一次**计划绑定校验**：计划里点名的工具必须已在本地执行表登记，否则抛错 → `main.ts` 的 crash 路径（可见失败优于“声明了但永远不生效”）。动态注册的工具没有计划条目 = 走老路径。

实现细节：计划在 Cell 内转成 `Map` 持有（避免 `__proto__` / `constructor` 等对象键歧义）；字段存在性用 `Object.hasOwn`（不取原型链）；参数来自 JSON 帧，值类型受 JSON 限制。

### 4.5 传给 handler 的治理参数

```ts
export interface DeclaredEffectView {
  readonly kind: string;
  readonly effectId: string; // 框架已声明，可用于目标系统幂等键
  readonly seq: number;
  readonly targetSummary: unknown;
  readonly paramsDigest?: { alg: "sha256"; hex: string };
}

export interface ToolExecutionContext {
  /** 业务能力出口（模型、账本等）。治理动作不再要求插件调用。 */
  readonly client: CellClient;
  /** 本次调用已由框架声明的效果；无治理声明时为空数组。 */
  readonly effects: readonly DeclaredEffectView[];
}
```

边界：

- **不传** `scope` / `subject` / `runId` / 预算量——身份由通道盖章（B2/B5 反面教材），治理量由内核拥有；
- `targetSummary` 是 manifest 指定的明文标识字段；敏感内容只进 `paramsDigest`；
- 纯业务 handler 可以完全忽略第二个参数；需要 effectId 的业务（如外部支付幂等）才读 `effects`；
- `paramsDigest` 的算法固定为“对选中字段对象做键排序的 JSON 规范化，再 SHA-256”，输出 `{alg:"sha256", hex}`，保证跨进程可复现；实现放在 `governance.ts`，不复用插件代码。

### 4.6 顺序与失败语义

| 时点    | 发生什么                                   | 失败时                                                                                 |
| ------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| guard   | `auth.check(cap, resource)`                | 授权器拒绝并写 `AUTH_DENIED`；工具返回 `AUTH/DENIED`，handler 不执行                   |
| declare | 逐个 `effect.declare`（每次一个 effectId） | 内核拒绝/超时 → 工具错误，handler 不执行；已声明的效果由宿主按工具结果结算（保守补偿） |
| handler | 纯业务                                     | 工具错误；已声明的效果按 `EFFECT_SETTLED{unknown}` 结算，进入补偿候选（T05/T06）       |
| settle  | 宿主按工具结果写 `EFFECT_SETTLED`          | 既有路径不变                                                                           |

**保守语义**：声明发生在 handler 之前，若 handler 因业务校验失败而没真正产生副作用，账本仍会有一条 `EFFECT_DECLARED`，补偿会尝试执行——因此补偿动作必须容忍“目标不存在”（T06 既有硬规则）。这是“先声明后动手”的必然代价，不是本次引入的新问题。

> **既有语义提醒（不在本片解决）**：工具级 retry（hook③，≤3 次）每次都会重新走 `tool.exec`，因此会重新声明一个 effect（新的 effectId）。跨 attempt 的幂等要么依赖目标系统的 natural 幂等，要么由策略层不重试；要复用同一个 effectId，需要 `tool.exec` 携带 toolCallId，属协议变更，另案。

> 与插件 C 的口径：策略 hook 在宿主侧、先于 `tool.exec`；切片③的 guard 是舱内第二道本地检查。C4 的危险参数用例应选 guard 覆盖不到的面（如内容模式/金额阈值），否则无法区分“策略拦截”与“守卫拒绝”。

### 4.7 与五大不变量的关系

- **I1 控制不可旁路**：授权仍由内核 Authorizer 裁决（guard 只是新增调用点）；effectKind 仍受 manifest 模板校验；意图声明不等于权限。
- **I2 故障不可级联**：拦截器在 Cell 进程内，超时/崩溃仍落在既有 `hardTimeout` / 进程边界；不新增跨进程等待。
- **I3 状态不可丢失**：计划随 spawn 一次送达，可复现；不引入宿主内存态。
- **I4 副作用不可无痕**：自动声明把“每个有副作用的工具必须先声明”从作者自觉变成框架默认；补偿口径不变。
- **I5 上下文不可全局污染**：计划按 Cell 实例持有，不进全局表；工具仍按 scope 分区。

## 5. 改造前后对比（以插件 B `file-write` 为例）

> 下面是**同一业务**的两种写法。改造前是按当前 `CellTool` 形状预计的代码；改造后是 04 稿方案落地后的目标形态。业务结果、补偿动作、账本事件都不变。

### 5.1 改造前：handler 里混着四类治理动作

```ts
// packages/plugins/file-write/src/index.ts —— 改造前
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";

// 插件不能 import @keel/*（零依赖纪律），只能手抄用得到的通道面
type ToolCtx = {
  client: {
    authCheck(action: string, resource: string): Promise<{ allowed: boolean; reason?: string }>;
    declareEffect(decl: {
      effectKind: string;
      targetSummary?: unknown;
      compensation: { paramsDigest?: unknown };
    }): Promise<{ effectId: string; seq: number }>;
  };
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const tools = [
  {
    name: "write_file",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (params: unknown, { client }: ToolCtx) => {
      const { path, content } = params as { path: string; content: string };

      // ① 治理：手工权限检查
      const decision = await client.authCheck("fs.write", `fs:${path}`);
      if (!decision.allowed) throw new Error(`write denied: ${decision.reason ?? path}`);

      // ② 治理：手工副作用声明（必须先声明后动手）
      await client.declareEffect({
        effectKind: "file.write",
        targetSummary: { path },
        compensation: { paramsDigest: { path, contentSha256: sha256(content) } },
      });

      // ③ 业务：真正写文件
      await writeFile(path, content);
      return { path, bytes: Buffer.byteLength(content) };
    },
  },
];

export const compensations = {
  "file.remove": async (input: { targetSummary: { path: string } }) => {
    await rm(input.targetSummary.path, { force: true });
    return { removed: input.targetSummary.path };
  },
};
```

manifest 里只有“允许 fs.write + 有补偿模板”，**没有“哪个工具声明哪个效果”**：

```json
{
  "permissions": [
    { "cap": "tool.provide", "reason": "提供 write_file" },
    { "cap": "fs.write", "allow": ["fs:/tmp/keel-workspace/**"], "reason": "写入工作区" }
  ],
  "compensation": {
    "templates": [
      {
        "kind": "file.write",
        "class": "reversible",
        "action": { "type": "plugin", "ref": "file.remove" },
        "idempotency": "natural"
      }
    ]
  }
}
```

### 5.2 改造后：handler 只剩参数与业务

manifest 增补治理声明：

```json
"governance": {
  "tools": [
    {
      "name": "write_file",
      "guard": { "cap": "fs.write", "from": "path", "prefix": "fs:" },
      "effects": [
        { "kind": "file.write", "targetFields": ["path"], "digestFields": ["path", "content"] }
      ]
    }
  ]
}
```

代码缩到：

```ts
// packages/plugins/file-write/src/index.ts —— 改造后
import { rm, writeFile } from "node:fs/promises";

export const tools = [
  {
    name: "write_file",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (params: unknown) => {
      const { path, content } = params as { path: string; content: string };
      await writeFile(path, content);
      return { path, bytes: Buffer.byteLength(content) };
    },
  },
];

// 补偿是业务（怎么撤销这次写），留在插件；治理输入由宿主给
export const compensations = {
  "file.remove": async (input: { targetSummary: { path: string } }) => {
    await rm(input.targetSummary.path, { force: true });
    return { removed: input.targetSummary.path };
  },
};
```

执行时框架自动完成：`authCheck("fs.write", "fs:/tmp/...")` → `declareEffect({effectKind:"file.write", targetSummary:{path}, compensation:{paramsDigest:{alg:"sha256",hex:"..."}}})` → handler。**handler 里没有一次治理调用，也没有手抄的通道类型。**

### 5.3 需要 effectId 的业务（治理参数自动传递）

外部支付/写接口要用 `effectId` 做幂等键时，handler 读只读上下文即可：

```ts
handler: async (params: unknown, { effects }: { effects: readonly { effectId: string }[] }) => {
  const { account, amount } = params as { account: string; amount: number };
  await payment.charge({ account, amount, idempotencyKey: effects[0].effectId });
  return { charged: amount };
},
```

`effectId` 由框架在 handler 之前拿到并传下来——作者不需要自己声明，也不需要自己生成/透传。`scope` / `subject` / `runId` 依旧不进 handler（身份由通道盖章）。

### 5.4 开发体验差量

| 事项          | 改造前                                    | 改造后                                         |
| ------------- | ----------------------------------------- | ---------------------------------------------- |
| 通道类型      | 手抄 `ToolCtx` 结构类型                   | 不需要（纯 handler 只写 `params`）             |
| 权限检查      | handler 内手写 `authCheck`                | manifest `guard`，框架执行                     |
| 副作用声明    | handler 内手写 `declareEffect` + 顺序纪律 | manifest `effects`，框架在 handler 前执行      |
| 摘要计算      | 插件自己算 SHA-256/拼字段                 | 框架按 `digestFields` 算                       |
| effectId 获取 | `declareEffect` 返回值                    | `ctx.effects[].effectId`                       |
| 补偿动作      | 插件写                                    | 插件写（业务，不变）                           |
| 漏声明的风险  | 靠作者自觉，账本看不出来                  | 有治理声明的工具由框架保证；未声明仍是评审问题 |

账本可观察面不变：两种写法都产出 `TOOL_INVOKE` → `EFFECT_DECLARED` → `EFFECT_SETTLED` → `TOOL_RESULT`；差别只在“谁填写 effectKind / targetSummary / paramsDigest”（改造前是作者，改造后是 manifest + 框架）。

## 6. 兼容性

- **echo**：无 governance、handler 只收 params；零改动。
- **既有 handler**：第二参数从 `{client}` 扩为 `{client, effects}`（超集），Cordis 适配层与既有 fixture 的 `(params, {client})` 结构类型仍可赋值；不改调用方式。
- **Cordis 适配层**：合成的 manifest 没有 governance → 不生成计划 → 仍走手动 `declareEffect` 老路径；归档代码与测试不动。
- **动态注册工具**：运行期 `cell.registerTool` 的名字若没有计划条目，照旧；有计划条目则生效（文档提示：原生插件静态工具优先）。
- **策略舱 / 观测舱**：policy/observation 禁止 governance；bootstrapExtra 仅策略舱带 `hooks`。
- **不新增**：通道 op、事件类型、错误码、超时时限、运行时依赖。守卫拒绝复用 `AUTH/DENIED`；计划/字段错误复用 `SCHED/MANIFEST-INVALID`、`TRANSPORT/BADFRAME`。

## 7. 切片③验收（机制层，不替代 C3）

> 红测先行（standards/05）：先写“纯 handler 应自动声明”的失败测试，再实现。

- **G1**：无治理计划 → 不发 `auth.check` / `effect.declare`，handler 行为与今天一致（兼容）。
- **G2**：有 guard → 先 `auth.check`，拒绝时 handler 零调用、工具结果为 `AUTH/DENIED`（内核已写 `AUTH_DENIED`）。
- **G3**：有 effects → 在 handler 前发 `effect.declare`；payload 的 `effectKind` / `targetSummary` / `paramsDigest` 与计划一致。
- **G4**：声明被拒/超时 → handler 零调用；错误码透传。
- **G5**：`ctx.effects[].effectId` = 内核返回的 effectId；`targetSummary` / `paramsDigest` 形状可复现。
- **G6**：缺 `targetFields` 声明的字段 → `TRANSPORT/BADFRAME`，handler 零调用。
- **G7**：`markReady` 时计划点名未注册工具 → 抛错（装载可见失败）。
- **G8**：旧 handler `(params, {client})` 与纯 handler `(params)` 均编译/运行通过。
- **H1~H4（host）**：装配器接受合法 governance、拒绝 policy 带 governance / 未声明 cap / 未知 kind / 重复工具名；`compileGovernancePlan` 不产生空项；`SupervisedCell` bootstrap 带上计划；无声明时载荷形状不变。
- **E1（真进程 fixture）**：一个最小写文件插件 + governance，跑真实 Cell：账本序 `TOOL_INVOKE` → `EFFECT_DECLARED` → `EFFECT_SETTLED` → `TOOL_RESULT`，handler 内零治理调用；guard 拒绝路径与声明失败路径各一条。
- **门禁**：六道门禁全绿；`cell.ts` 拆分后单文件 ≤600 行（新增切面放 `governance.ts`）。

C3（补偿闭环）仍由切片④的插件 B 在真实报关单上验收；切片③只证明机制与负路径。

## 8. 难度评估

| 工作项                                           | 量级 | 说明                                                                  |
| ------------------------------------------------ | ---- | --------------------------------------------------------------------- |
| manifest Schema + 装配器语义校验                 | M    | 公开契约；约 50 行 Schema + 80~120 行校验/测试；须 ADR                |
| 宿主治理计划编译 + bootstrap 接线                | S    | 约 60 行 + 少量测试；复用 `bootstrapExtra` seam                       |
| Cell-Runtime 拦截器链 + 摘要/字段选择 + 计划校验 | M    | 约 200~250 行（拆到 `governance.ts`，`cell.ts` 只加编排）+ 250 行测试 |
| 真进程 fixture + e2e                             | M    | 约 200 行；红测先行                                                   |
| 文档（本稿 + ADR + 规范回填）                    | S    | 约 350 行 + ADR ≤100 行                                               |

**结论：中等偏低**（相对 Phase 2 任一切片）。代码量约 600~900 行含测试，无新依赖、无新 op/事件/错误码；真正成本在 **manifest 契约决定** 与 **验收证据**，不在拦截器本身。预计 1~2 个专注会话（设计定稿后）。

难点与不确定性：

1. **契约形状**：`governance` 要够插件 B 用，又不能长成通用表达式语言（D1/D2）；这是一次性决定，改起来贵。
2. **保守声明的副作用**：handler 前声明意味着“可能没发生也要补偿”，必须坚持 T06 容忍不存在的目标；测试要覆盖。
3. **兼容面**：Cordis 适配层仍调 `declareEffect`，不能误伤；`CellTool` 类型扩第二参数要保持结构可赋值。
4. **不能宣称安全性**：AOP 只约束“守规矩的插件”，恶意插件仍可直接 IO；文档与评审口径必须诚实。

## 9. 风险与边界

| 风险                                          | 应对                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 把 AOP 说成沙箱，误导后续设计                 | 文档与 REVIEW 明确：边界 = 进程隔离 + manifest 授权 + 评审；AOP 是治理代劳层                                                                                 |
| `targetSummary` 明文泄露敏感内容              | 只允许标识类字段；内容走 `digestFields`；REVIEW 逐项核对                                                                                                     |
| 声明了却没生效（计划与工具名不一致）          | `markReady` 绑定校验 → 装载即失败（可见）                                                                                                                    |
| 过度声明导致“补偿不存在的东西”                | 补偿动作容忍目标不存在（T06）；测试覆盖                                                                                                                      |
| 计划与 manifest 漂移                          | 计划由宿主从 `LoadedManifest` 纯编译；Cell 不读 manifest 文件                                                                                                |
| 同一工具“自动声明 + 手动声明”双声明           | 原生插件评审禁止 handler 手动 `declareEffect`；Cordis 合成 manifest 不生成计划；候选：把 `declareEffect` / `authCheck` 加入原生插件禁面符号表（D5 施工时定） |
| 将来要嵌套字段/多效果依赖/条件声明/自定义摘要 | `dependsOn` / JSONPath / 条件声明 / 自定义摘要形状不在本片；有真实需求另写 ADR                                                                               |

## 10. 决策记录（2026-11-03 定案）

| #   | 问题                                                                                     | 建议                                                                                                                                | 影响                    |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| D1  | 治理声明放哪：新增顶层 `governance.tools[]` / 挂到 `compensation.templates[]` / 代码注解 | **新增 `governance` 节**（职责单一、可被 Schema 约束；模板可被多工具复用，不适合做绑定）                                            | manifest Schema 与 ADR  |
| D2  | 目标/摘要字段怎么选：顶层字段名 / JSONPath / 模板字符串                                  | **顶层字段名**（v1 够用，零表达式解析；嵌套需求另案）                                                                               | 插件 B 的 manifest 写法 |
| D3  | 权限守卫范围：`fs.read`/`fs.write` / 同时支持 `net.fetch`                                | **先 fs.\***；`net.fetch` 需要主机名归一与运行期 op，另案                                                                           | 守卫覆盖面              |
| D4  | handler 第二参数：只传 `effects` / 同时传 `scope`/`subject`/`runId`                      | **只传 `effects` + 既有 `client`**；身份与治理量不进舱（B2/B5）                                                                     | 纯业务边界              |
| D5  | 边界能力是否强制要求治理声明：装配器强制 / 仅原生插件评审强制 / 暂不强制                 | **装配器暂不强制（避免误伤归档 Cordis 件）；原生插件先由 REVIEW 强制（是否加 manifest 扫描规则在施工时定）**；三件套齐后在切片⑤复评 | 是否破坏兼容            |
| D6  | 切片位置：新增切片③ AOP 先行 / 并入插件 B / 放到 B 之后                                  | **新增切片③ 先行**（B 是第一个写者，先建底座避免返工）                                                                              | 排期与验收锚            |

> D5 的理由：当前 Cordis 合成 manifest 可能带 `fs.write` 却没有 governance；装配器一刀切会破坏“归档可单独复跑”。原生插件是首批标杆，先用评审纪律把口子收住，等三件套齐了再决定是否升级为装配器硬规则。
>
> 2026-11-03 定案：D1~D6 按“建议”列执行；D5 保持装配器 opt-in + 原生插件 REVIEW 强制。内置补偿与 record-only 简化的配套决策见 [05 稿](05-builtin-compensation.md) / [ADR-0016](../../adr/ADR-0016-builtin-compensation-registry.md)。

## 11. 定稿后的施工顺序

1. 所有者确认 D1~D6 → 本稿转定稿；
2. 新增 **ADR-0015**（manifest 治理声明 + 拦截器链；含兼容性与“不是沙箱”边界）；
3. 修订 `keel-plugin.schema.json` 与 manifest 稿（带日期注记）；
4. **红测先行**：G1~G8、H1~H4、E1 先红；
5. 实现宿主编译/校验 → Cell 拦截器链 → fixture e2e；
6. `main.ts` / `supervisor.ts` / `LoadedManifest` 接线；跑六道门禁；
7. 更新 `packages/plugins/README.md`（原生插件写法）与 REVIEW 模板；
8. 切片④：插件 B 用纯 handler 实现，补 C3；插件 C 补 C4。

## 12. 自检清单

- **铁律 1**：本稿先于实现；2026-11-03 定稿后实现已落地（拦截器链 + 宿主计划编译 + G1~G8/E1 测试）。
- **铁律 3**：收尾四件事随会话归档（CONTEXT / handoff / 沉淀 / 体量）。
- **铁律 5**：本片只做 AOP 底座；插件 B/C 的验收留在切片④。
- **铁律 7**：G1~G8 / E1 先红后绿；C3 的补偿闭环仍由插件 B 的真进程证据承担。
- **I1**：授权仍在内核；**I2**：拦截器不新增跨进程等待；**I3**：计划可复现；**I4**：自动声明 + 模板校验；**I5**：计划按 Cell 实例持有。
- **实现证据（2026-11-03）**：`packages/cell-runtime/test/governance.test.ts`（G1~G8）、`packages/host/test/governance.test.ts`（计划编译）、`packages/host/test/assembler.test.ts`（治理语义校验）、`tests/native-file-write-aop.test.ts`（真进程 A1/A2）。

## 13. 2026-11-03 R3 后续注记（ADR-0018）

- 本轮 AOP 的 `guard` 仍是**咨询性检查**：它查 `params`，不证明 handler 实际写了哪里。R3 起写文件的唯一黄路径是 `ctx.workspace.create/overwrite`——宿主执行真实 IO、按声明目标比对、签发收据；`fs.remove` 只认收据。直接 `fs.writeFile` 的插件不会产生收据，内置删除不会碰它。
- `ToolExecutionContext` 追加 `workspace` 与 `toolCallId`（旧 handler 仍可只声明 `(params)` 或 `(params,{client})`，结构超集）。
- 单 effect 的 workspace 调用自动绑定；多 effect 必须显式传 `effectId`（不猜）。
- AOP 声明仍是“意图”，不升级为“事实”；事实由 `EFFECT_SETTLED.receipt` 承载。
