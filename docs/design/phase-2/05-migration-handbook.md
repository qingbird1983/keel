# Cordis 插件迁移手册（切片③ 首版）

- 状态：**首版**（2026-11-03 随 Phase 2 切片③ 交付；覆盖 [01 稿 边界表](01-cordis-migration-boundary.md) 全部 7 条 C 档行的 before/after，其中 B3 三条有真进程样本）
- 读者：**存量 Cordis 插件的写法方**（不是本项目评审）。评审口径看 01/02/03/04 四份设计稿与 [phase-2 合同](../../roadmap/phase-2-cordis-compat.md)
- 材料性质：本手册的"旧写法片段"是我们按旧框架典型写法**亲手写出的合成样本**，不是从真实存量插件里摘的——真样本到位后按 01 稿 §5 的义务回填，在此之前不得表述为"真实存量插件已验证"

## 0. 怎么读这一份

每节固定五段：**旧写法** → **为什么这是病灶**（一句）→ **改法**（可抄）→ **跑在哪**（有证据的位置）→ **行为差异**（从此有什么不一样）。

三条事先说清的边界：

1. **没有兼容开关**。想找一个"先按旧写法跑起来、以后再改"的旋钮——不存在。映射不到的旧面一律当场报错并写明改法去处，这是设计（02 稿 §3 姿态 1：静默降级等于把旧框架的病灶以新框架的名义重造一遍）。
2. **"补一张报关单"和"改一小段代码"是分开的**。前者只加 manifest，后者必须动代码；本手册只收后者（七条）。
3. 改法里的新面（`ctx.model.invoke` / `ctx.effects.declare` / `ctx.ledger.read`）**不是旧面改名**。旧面（`ctx.llm.chat` / `ctx.effects.reclaim` / `ctx.share.*` / `ctx.bus.*`）一条都没放行，仍然抛 `ADAPTER/UNSUPPORTED`。

装配报关单（manifest）本身的写法见 [manifest 设计稿](../phase-1/03-plugin-manifest.md)；本手册只在需要新字段时给出那几行。

## 1. #1 注册与查表的返回值：一行 `await`

**旧写法**

```js
const t = ctx.tools.register("report.pdf", schema, handler);
console.log(t.schemaVersion); // 旧框架同步返回登记对象
const mine = ctx.tools.list().filter((x) => x.name.startsWith("report."));
```

**为什么这是病灶**：可见表在内核进程里，跨进程写必然有一次往返；"同步返回 + 后台 flush"要么让插件自己算版本号（等于把全局注册表搬回插件进程），要么让失败发生在插件看不见的时刻。

**改法**（只加 `await`，其余原样）

```js
const t = await ctx.tools.register("report.pdf", schema, handler);
console.log(t.schemaVersion); // 版本号由内核指派
const mine = (await ctx.tools.list()).filter((x) => x.name.startsWith("report."));
```

**跑在哪**：`tests/fixtures/cordis-plugins/tierA-01-toolset.cjs` 等 A 档样本 + `tests/cordis-adapter-tier-a.test.ts`（B1）。注意 activation 里的注册**要 await**：不 await 且该调用被内核拒绝 = 未决拒绝 = 本舱进程非零退出（可见的 `RUN_FAILED`），不是"注册悄悄没生效"。

**行为差异**：注册只对你自己那个会话可见；同名条目各域各版本；`handler` 只在你的舱里执行，内核只认工具名。

## 2. #4 自取密钥 → 声明所需能力

**旧写法**

```js
const key = ctx.config.get("OPENAI_KEY") || process.env.OPENAI_KEY;
```

**为什么这是病灶**：插件持有密钥就没有"用量由内核权威记账"可言，也没有裁决与留痕的落点；而把密钥塞进启动参数等于放进进程命令行（进程列表可见）。

**改法**：删掉这一行。**不存在**"读密钥再自己调"的等价面——需要什么能力就声明什么：

```jsonc
// manifest.permissions（节选）
[{ "cap": "model.adapter" }, { "cap": "net.fetch", "allow": ["api.example.com"] }]
```

模型走 §3 的网关面；网络按 `net.*` 词表裁决并留痕。**观察不到的调用面一律进缺项清单**（两遍观察 + 人工审核的路径见 [03 稿](03-manifest-synthesis.md) §4），而不是"先给它一条通配规则"。

**跑在哪**：`tests/cordis-manifest-synthesis.test.ts`（B2 的缺项清单主张）；`ctx.config.get` 的拒绝与去处见 `packages/cordis-adapter/test/index.test.ts`。

**行为差异**：密钥不在插件手里；未声明 = 无规则 = 当场拒并落 `AUTH_DENIED`（可查），不再"运行期才炸"。

## 3. #6 自带 SDK 调模型 → `ctx.model.invoke(reqId, {…})`

**旧写法**

```js
const openai = require("openai")(process.env.KEY);
async function ask(p) {
  const r = await openai.chat(p.prompt);
  myLedger.push({ tokens: r.usage.total, cost: r.usage.total * 0.002 }); // 插件自己记一笔
  return r;
}
```

**为什么这是病灶**：用量由插件自报 = 预算与审计都没有事实源；同一请求重发一次就多算一次钱，还没有幂等口径。

**改法**（`reqId` 是**第一个必填参数**，由你决定并复用）

```js
ctx.tools.register("ask", schema, async (params, ctx) => {
  const r = await ctx.model.invoke(params.reqId, {
    model: "gpt-stub",
    params: { prompt: params.prompt },
    estimate: 100, // 预扣依据；实结由内核按权威计量
  });
  // r = { result, usage, cost, replay }
  return r.result;
});
// 插件里"我自己记一笔花了多少"的代码删掉。
```

`replay: true` 表示同一个 `reqId` 命中了已结算的调用：不重打上游、不重复计费。这条保护完全取决于**你把业务上的"同一次请求"编成同一个号**——自动生成等于每次都是新请求（这也是这一行必须改写、不能自动映射的原因，见 04 稿 §8 第 1 项）。

**跑在哪**：`tierC-06-self-key.cjs`（before：消耗发生在外、账本关于它零事实、`ctx.llm.chat` 当场拒）与 `tierC-06-gateway.cjs`（after：同 `reqId` 两次调用，上游只被打一次、`BUDGET_RESERVED`/`BUDGET_SETTLED`/`MODEL_USAGE` 各一条）——断言在 `tests/cordis-c-surface.test.ts`。

**行为差异**：调用经授权 → 预扣 → 代理 → 实结四步，全程留痕；未报关 `model.adapter` 的插件调用即 `AUTH/DENIED`。

## 4. #8 跨插件共享可变状态 → 谁产生谁持有

**旧写法**

```js
ctx.tools.register("make", schema, (p, ctx) => {
  ctx.share.set("peer-key", p.token); // 指望另一个插件去读
  return { ok: true };
});
```

**为什么这是病灶**：共享可写袋是旧框架最难查的污染源（谁写过、什么时候写的、值从哪来都没有答案），而且写一半失败会留下半状态。

**改法**：状态留在产生它的那个舱里，要给别人的那一份**从工具返回值出去**，由内核带到下一轮决策，再作为对方工具的入参发进去。

```js
var owned = null; // 舱内私有
ctx.tools.register("note.new", schema, async (p) => {
  owned = { token: p.token };
  return { token: owned.token }; // ← 唯一的跨舱载体
});
ctx.tools.register("note.peek", schema, async () => ({ owned })); // 自己这边仍可读
```

对方（另一个会话、另一份插件）拿到的是入参：

```js
ctx.tools.register("note.audit", schema, async (p) => ({ got: p.token }));
```

**没有"别人状态"的注入通道**，跨插件直接写对方状态永久拒绝——这是设计，不是缺失（04 稿 §10 第 3 条）。你能用的只读面是：本 run 的账本（§7）与本 scope 的工具表（`ctx.tools.list()`）。

**跑在哪**：`tierC-08-share.cjs`（before：当场拒、没有任何一半落下去）与 `tierC-08-carry.cjs` + `tierC-08-peer.cjs`（after：两个作用域，值确实换了舱、两域可见表互不可见）——`tests/cordis-c-surface.test.ts`。

**行为差异**：每个会话一份状态，互不污染；想按会话编号做全局操作也做不到（`ctx.scope` 读任何字段即抛，作用域由宿主盖章）。

## 5. #9 运行时回收副作用 → 动手前报关

**旧写法**

```js
ctx.tools.register("write", schema, async (p, ctx) => {
  fs.writeFileSync(p.file, p.text); // 先动手
  ctx.effects.reclaim("effect-" + p.tag); // 出事再临时决定怎么收尾
});
```

**为什么这是病灶**："出事了再想办法"在跨进程世界里等于没有方案——崩溃发生在谁身上、还剩什么没撤，都无人知道。

**改法**：这一条**要改两处**。

（a）报关单里预登记补偿模板（动作与幂等口径在这里给，不在代码里）：

```jsonc
"compensation": { "templates": [
  { "kind": "fs.write.done", "class": "reversible",
    "action": { "type": "plugin", "ref": "undo-write" }, "idempotency": "keyed" }
]}
```

（b）代码把"动手后 reclaim"换成"动手前 declare"，并把撤回动作本身作为一张表交出去：

```js
ctx.tools.register("write", schema, async (p, ctx) => {
  await ctx.effects.declare({
    effectKind: "fs.write.done", // 必须命中上面的模板，否则 SCHED/MANIFEST-INVALID
    targetSummary: p.file, // 补偿动作在**另一个进程**里执行，靠它定位目标
    paramsDigest: { bytes: p.text.length },
  });
  fs.writeFileSync(p.file, p.text); // 再动手
});

module.exports.compensations = {
  "undo-write": async (input) => {
    // input = { actionRef, effectId, targetSummary, paramsDigest, phase }
    if (fs.existsSync(String(input.targetSummary))) fs.rmSync(String(input.targetSummary));
    return { undone: true }; // 必须容忍目标不存在：补偿可能被重放
  },
};
```

`effectId` 与"用哪个补偿动作"都不由你决定（前者由 Cell 侧指派、后者由报关单决定）；在 `declare` 里传 `effectId` / `compensation` / `probeRef` 会被直接拒（`ADAPTER/ARGS-REQUIRED`）。撤不撤、怎么撤由内核的补偿状态机编排，插件不参与编排。

**跑在哪**：`tierC-09-reclaim.cjs`（before：副作用做了、账本里既无 `EFFECT_DECLARED` 也无补偿痕迹）与 `tierC-09-declare.cjs`（after：报关 → 失败 → `RUN_FAILED` → 宿主起**同插件的新舱**执行 `undo-write` → `COMPENSATION_EXECUTED` 落账，重派不重复）——`tests/cordis-c-surface.test.ts`。

**行为差异**：副作用从"事发后想办法"变成"动手前报关"；临场编造的效果声明被拒且不留副作用（C-M1 焊点）；补偿执行在独立新进程里，不依赖原舱还活着。附带一条：`module.exports.snapshot = () => state` 可把私有状态暴露给宿主轮边界索取（本片只登记通道，物理持久化在切片⑤）。

## 6. #12 依赖别人的注册顺序 → 改成显式动作

**旧写法**

```js
// 指望别的插件先加载、先把 "report.pdf" 注册好
const target = ctx.tools.list().find((t) => t.name === "report.pdf");
```

**为什么这是病灶**：靠加载顺序建立的隐式耦合没有失败面——顺序变了就行为变了， yet 没有任何一处报错。

**改法**：作用域隔离 + 装载门使每个舱只看得见自己注册过的名字（`probe-order.cjs` 已实证跨插件顺序耦合结构上不成立）。所以把"指望别人准备好"改成两种显式动作之一：**要对方干活就调用它提供的工具**（名字经可见表与授权裁决、全程留痕）；**要确认发生了什么就读只读账本**（§7）。没有"manifest 依赖声明"这种字段，扩字段属超范围（01 稿 #12 注记）。

**跑在哪**：`tests/fixtures/cordis-plugins/probe-order.cjs` + `tests/cordis-adapter-tier-a.test.ts`（B1②）；账本读面见 `tierC-08-peer.cjs`。

**行为差异**：看不见别舱的名字（不是"看不见但能调"，也不是"能看见但调不动"）；隐式顺序问题从此没有载体。

## 7. #15 跨插件事件总线 → 工具参数或只读账本

**旧写法**

```js
ctx.bus.emit("doc.ready", { id: p.id }); // 谁在听全凭约定
ctx.bus.on("doc.ready", handler);
```

**为什么这是病灶**：一条没有授权、没有留痕、也无法重放的通道；"谁先发、谁在听"只存在于口头约定里。

**改法**：二选一。

```js
// (a) 需要对方干活 → 意图放进**你自己工具的返回值**里，由决策在下一轮把对方的工具调用出去。
//     注意：你的插件不能安排下一动作（那是 D 档 #7），它能给的只是一段数据。
return { intent: { tool: "index.build", params: { id: p.id } } };

// (b) 需要让别人看到发生了什么 → 读本 run 的只读账本
const page = await ctx.ledger.read(); // { events: [...] }，仅本 run
```

`ctx.ledger.read` 的过滤面只有 `types` / `seqFrom` / `seqTo` 三位：`runId` 由宿主在通道绑定上盖章，插件传了会被直接拒。跨 run 的订阅归观测生态（Phase 3）。**不做"舱内假总线"**——那正是病灶的载体。

**跑在哪**：`tierC-08-peer.cjs`（after 的 (b) 一支，真进程读到 `ASSEMBLY_RECORDED`/`RUN_STARTED`/`TOOL_INVOKE`）；`ctx.bus.*` 的拒绝与去处见 `packages/cordis-adapter/test/index.test.ts`。

**行为差异**：事件不再"发出去就消失"——要么是一条被授权、被记账的工具调用，要么是一条能从账本重放出来的事实。

## 8. D 档：这两条路不存在，出路不是改写

| 旧写法                                     | 为什么永远拒绝                          | 等价出路                                                                                           |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| #7 插件自己判断预算/停止条件、接管下一动作 | 插件不能替换 Agent Loop（不变量 I1/V6） | 白名单四个 hook（审批 / 停止建议 / 重试建议 / 耗尽选择），且响应里夹带"下一动作"类字段会被直接拒绝 |
| #14 用策略插件绕开控制面                   | 控制面唯一是内核；这是 Keel 存在的理由  | 同上：`kind:"policy"` 的 manifest 按四 hook 白名单声明；能力插件不持钩子面                         |

D 档零例外（所有者确认 2026-11-02）：不因"存量插件普遍这么写"而开口子。**注意**：策略插件 → hook 总线的装配链尚未接通（Phase 1 登记的限制），本手册这里只给出方向；证据由切片④补（[合同 §6 风险 3](../../roadmap/phase-2-cordis-compat.md)）。承接层对 `ctx.hooks.*` 抛 `ADAPTER/UNSUPPORTED`，不会"先注册上、以后再管"。

## 9. 迁移检查清单

- [ ] activation 里的注册/查表都 `await` 了（§1）
- [ ] 删掉了所有自取密钥与自带 SDK 的调用，改成 manifest 声明能力（§2、§3）
- [ ] 模型调用改为 `ctx.model.invoke(reqId, {model, params, estimate})`，且业务上"同一次请求"复用同一个 `reqId`（§3）
- [ ] 跨插件共享状态拆成"谁产生谁持有 + 值经工具参数传递"（§4）
- [ ] 副作用改为动手前 `ctx.effects.declare`，并给出 `module.exports.compensations` 表与报关模板（§5）
- [ ] 不再指望别人的加载顺序；需要对方干活就显式调用（§6）
- [ ] 去掉了 `ctx.bus.*`；改用工具参数或 `ctx.ledger.read`（§7）
- [ ] 全文检索 `ctx.share` / `ctx.effects.reclaim` / `ctx.hooks` / `ctx.config` / `ctx.llm` / `ctx.net` / `ctx.scope` ——**必须零命中**（这些面一条都没放行）
- [ ] 长任务与定时器不指望阻塞主进程（每 run 独立进程，快照面暴露私有状态）

真进程验收看 `tests/cordis-c-surface.test.ts`（B3）与 `tests/cordis-symbol-scan.test.ts`（B5：样本里每个 `ctx.*` 符号必须在四桶清单里有归属，未归类即红）。
