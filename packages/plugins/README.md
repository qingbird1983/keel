# packages/plugins —— Keel 原生标杆插件

Phase 3 的原生 manifest 插件目录（[合同](../../docs/roadmap/phase-3-native-ecosystem.md) §2 目录定案）。首批三件套：`echo` / `file-write` / `param-guard`（需求卡见 [02 稿](../../docs/design/phase-3/02-review-mechanization.md) §4）。

- 每个插件是 workspace 包（private、零三方依赖）；manifest 是插件行为的唯一事实源
- 转正前置：禁面扫描零命中（`node scripts/scan-native-plugins.mjs`）+ `REVIEW.md` 逐条留痕
- 本文件是占位说明（空目录不入库）；切片② 起落插件

## 写一个带副作用的工具（切片③起）

**默认写法 = 纯 handler + manifest 声明**（[ADR-0015](../../docs/adr/ADR-0015-manifest-governance-and-cell-aop.md) / [ADR-0016](../../docs/adr/ADR-0016-builtin-compensation-registry.md)）：

```ts
// handler 只处理参数与业务：不调 authCheck、不调 declareEffect、不算摘要、不写撤销代码
handler: async (params, ctx) => {
  const { path, content } = params as { path: string; content: string };
  const r = await ctx.workspace.create({ path, content });
  return { path, bytes: r.bytes };
},
```

manifest 负责治理与补偿：

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

- **框架自动做**：`auth.check(cap, prefix + params[from])` → 逐个 `effect.declare` → `handler`；任一步失败 handler 不执行。
- **写文件走 `ctx.workspace`（R3，[ADR-0018](../../docs/adr/ADR-0018-effect-receipts-and-workspace.md)）**：宿主独占创建/显式覆盖、解析路径并签发收据；直接 `fs.writeFile` 不会产生收据，`fs.remove` 不会删它。`create` 目标已存在 → `WORKSPACE/EXISTS`；路径逃逸 → `WORKSPACE/PATH`/`AUTH/DENIED`。
- **内建补偿**：首版只有 `fs.remove`（只删“本次创建且 identity 相符”的单文件，不递归）。覆盖写会丢旧内容且不享受内建删除 → 用 `record-only` 或插件自定义补偿；网络无通用撤销。
- **record-only 极简声明**：模板只写 `{ "kind": "...", "class": "record-only" }`，不用填 action/idempotency；账本留痕 + 告警。
- **需要 effectId 的业务**（外部支付/写接口幂等）：单 effect 的 `ctx.workspace` 自动绑定；多 effect 必须显式传 `ctx.effects[i].effectId`；其余业务不需要第二参数。
- **生命周期（R4）**：可选 `export function setup(ctx)` 用 `ctx.effect(cleanup)` 注册资源清理、`ctx.tools.register` 注册动态工具；可选 `export function dispose()`；宿主收尾按“模块 dispose → 资源 effect LIFO”执行。
- **信任（R5）**：raw IO 需 manifest `trust.rawIo` 申请 + 宿主 `allowRawIo` 授予；未授予 = 装配拒绝。默认走能力，raw 不享受内置补偿。
- **边界**：AOP 是治理代劳层，**不是沙箱**；handler 仍可直接 IO。真正边界 = Cell 隔离 + manifest 授权 + 评审。
- 完整对照与实测行数见 [06 DX 报告](../../docs/design/phase-3/06-dx-compensation-report.md)；可运行样例见 [`tests/fixtures/file-write-plugin/`](../../tests/fixtures/file-write-plugin/)。
