# Phase 3 切片③开发者体验报告：一个带补偿的 file-writer 从 53 行到 24 行

- 状态：**定稿**（报告，2026-11-03；配套 [04 AOP 稿](04-cell-runtime-aop.md) / [05 内置补偿稿](05-builtin-compensation.md) / [ADR-0015](../../adr/ADR-0015-manifest-governance-and-cell-aop.md) / [ADR-0016](../../adr/ADR-0016-builtin-compensation-registry.md)）
- 日期：2026-11-03
- 证据：[`tests/fixtures/file-write-plugin/`](../../../tests/fixtures/file-write-plugin/)（真实进程可执行件）+ [`tests/native-file-write-aop.test.ts`](../../../tests/native-file-write-aop.test.ts)

## 1. 结论先行

同一业务（写文件 + 可撤销 + 权限受控），插件作者需要亲手维护的代码从 **53 行降到 24 行**，其中：

- **治理胶水（权限检查 / 摘要计算 / 副作用声明）= 26 行 → 0 行**；
- **撤销代码（compensations 导出）= 5 行 → 0 行**（`builtin fs.remove` 承担）；
- **handler 本体 = 5 行纯业务**，不接收 `ctx.client`、不出现任何治理词汇。

“不可逆的治理”确实变成了框架能力：**manifest 声明一次，Cell-Runtime 每次调用自动执行**。但它是治理代劳层，不是沙箱（见 §5 边界）。

## 2. 改造前：业务被四类治理动作包围

以下为 [04 稿 §5.1](04-cell-runtime-aop.md#51-改造前handler-里混着四类治理动作) 的同一业务写法（53 行代码，不含围栏）：

```ts
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

问题不在“写得出来”，而在**每个有副作用的工具都要重抄一遍**：顺序纪律（先声明后动手）、摘要口径、错误码、撤销动作，全凭作者自觉。漏一处不会编译失败，只会让账本失真。

## 3. 改造后：真实可执行件只有 24 行

下面是仓库内真件（`wc -l` = 24，非示意稿），也是 e2e 实际装载的模块：

```js
// AOP 机制样例（切片③，04/06 稿）：handler 只有参数与业务，零治理调用、零撤销代码。
// 治理由 manifest governance 声明、Cell-Runtime 织入；补偿由 builtin fs.remove 承担。
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

export const tools = [
  {
    name: "write_file",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (params) => {
      const { path, content } = params;
      await writeFile(path, content, "utf8");
      return { path, bytes: Buffer.byteLength(content, "utf8") };
    },
  },
];
```

manifest 里多了一段**声明**（不是每工具重复的代码）：

```json
"governance": {
  "tools": [
    {
      "name": "write_file",
      "guard": { "cap": "fs.write", "from": "path", "prefix": "fs:" },
      "effects": [
        { "kind": "fs.write.done", "targetFields": ["path"], "digestFields": ["path", "content"] }
      ]
    }
  ]
},
"compensation": {
  "templates": [
    {
      "kind": "fs.write.done",
      "class": "reversible",
      "action": { "type": "builtin", "ref": "fs.remove" },
      "idempotency": "natural"
    }
  ]
}
```

每次调用时框架自动完成（账本可核对）：

1. `auth.check("fs.write", "fs:" + params.path)` —— 拒绝则 handler 不执行；
2. `effect.declare({effectKind:"fs.write.done", targetSummary:{path}, paramsDigest:{alg:"sha256",…}})`；
3. `handler(params)` —— 只有业务；
4. 宿主按工具结果写 `EFFECT_SETTLED`；需要补偿时 **宿主内建 `fs.remove` 直接删文件**，不 spawn 补偿 Cell。

## 4. 差量账（可复核）

| 事项              | 改造前                                   | 改造后                                     | 作者手写行数变化 |
| ----------------- | ---------------------------------------- | ------------------------------------------ | ---------------- |
| 通道类型          | 手抄 `ToolCtx`（10 行）                  | 不需要                                     | −10              |
| 权限检查          | `authCheck` + 拒绝分支（4 行）           | manifest `guard`，框架执行                 | −4               |
| 副作用声明        | `declareEffect` + 顺序纪律（6 行）       | manifest `effects`，框架在 handler 前      | −6               |
| 摘要计算          | 手写 SHA-256 / 拼字段（1 行 + 口径风险） | 框架按 `digestFields` 算，固定 `{alg,hex}` | −1               |
| 撤销代码          | `compensations` 表（5 行）               | `builtin fs.remove`                        | −5               |
| **治理/撤销合计** | **26 行**                                | **0 行**                                   | **−26**          |
| 插件文件总量      | 53 行                                    | 24 行（含 schema，`wc -l`）                | **−55%**         |
| handler 块        | 18 行（含治理注释）                      | 5 行（纯业务）                             | −72%             |

一次性的 manifest 声明约为 9 行（governance）+ 9 行（模板），但它**不随工具数量重复治理逻辑**，且可被 Schema / 装配器 / REVIEW 逐项核对；代码里的 26 行则是每个工具都要重抄的隐形税。

## 5. 边界与不要误解的事

- **AOP 不是沙箱**：handler 仍可直接 `writeFile` 到别处。真正的边界 = Cell 进程隔离 + manifest 授权 + 人工评审；AOP 只是把“守规矩的治理义务”自动化。
- **`fs.remove` 只适合“本次新建的文件”**：覆盖写会丢掉旧内容，必须用 `record-only`（接受不可逆）或插件自定义补偿；`fs.restore` 尚未提供。
- **网络请求没有通用逆操作**：不要假装有；用 `record-only` 记录 + 告警，或由插件提供业务级补偿。内置补偿是闭集（首版 `fs.remove`），不是“万能撤销”。
- **保守声明**：声明发生在 handler 之前，业务校验失败时账本仍有一条 `EFFECT_DECLARED`；补偿动作必须容忍目标不存在（T06 既有硬规则）。
- **retry 的 effectId**：工具级 retry 每次重新 `tool.exec`，会声明新的 effect；跨 attempt 幂等依赖目标系统 natural 幂等，或另案让 `tool.exec` 携带 toolCallId。

## 6. 证据（可复跑）

- `tests/native-file-write-aop.test.ts` 三条真进程用例：
  - **A1**：账本序 `TOOL_INVOKE → EFFECT_DECLARED → EFFECT_SETTLED → TOOL_RESULT`；`EFFECT_DECLARED` 携带 `actionType:"builtin"` / `fs.remove` / SHA-256 摘要；`CompensationExecutor({factory:null})` 仍能完成补偿并删除文件。
  - **A2**：路径越界 → `AUTH_DENIED(fs.write)` 落账、handler 零执行、文件不存在、`TOOL_RESULT{error, AUTH/DENIED}`。
  - **A3**：注入 run 失败 → 调度器触发补偿 → `fs.remove` 自动删文件，账本含 `RUN_FAILED` + `COMPENSATION_EXECUTED`。
- `packages/cell-runtime/test/governance.test.ts`：G1~G8 拦截器链与失败语义。
- 本次报告的行数由 `wc -l tests/fixtures/file-write-plugin/index.mjs` 实测（24）；改造前取自 04 稿 §5.1 的同一业务实现（53 行代码）。

## 7. 对插件作者的默认建议

- **默认写法**：manifest 写 `governance` + `effects`，handler 只收 `params`；需要 effectId 做外部幂等的业务才读 `ctx.effects[0].effectId`。
- **先问“能不能删掉/撤回”**：能 → `reversible` + `builtin fs.remove`；只能缓解 → `mitigable`；真的不可逆 → `record-only` 极简声明（`{kind, class:"record-only"}`，不写 action/idempotency）。
- **先问“权限是什么”**：`guard` 的 `cap` 必须已在 `permissions` 且 `allow` 非空；`from` 字段必须与 handler 真正操作的目标一致（建议绝对路径）。

## 2026-11-03 R3 口径更新

- 写文件样例从 `node:fs/promises.writeFile` 改为 `ctx.workspace.create({path, content})`；handler 仍是 5 行纯业务，**撤销代码与治理胶水仍为 0**。
- 本报告“53 → 24 行”的整文件口径对应切片③的单工具样例。当前 `tests/fixtures/file-write-plugin/` 因覆盖多路径测试新增了 `overwrite_file`、`write_two`、`env_probe`，不再用整文件行数作 DX 指标；单工具 handler 的 5 行结论不变。
- 新增的安全收益：预存在文件不会被 create 覆盖、覆盖写不享受内建删除、路径逃逸在宿主解析后被拒、文件被替换后内建删除拒绝并升级。
