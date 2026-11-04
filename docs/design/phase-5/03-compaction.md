# Phase 5 切片①设计稿 03：压缩（视图操作、摘要治理、折叠与还原）

- 状态：**草稿**（2026-11-04 起草；随 ADR-0025 / ADR-0026 一起过第二道闸后转定稿）
- 日期：2026-11-04
- 关联：[phase-5 合同](../../roadmap/phase-5-session-continuity.md) §2/§5 E3/§6 S6·S7；[ADR-0026](../../adr/ADR-0026-compaction-as-view.md)（压缩是视图操作，待拍板）；[ADR-0021](../../adr/ADR-0021-session-ledger-topology.md) 决策 1/3/4；[ADR-0003](../../adr/ADR-0003-model-gateway.md)（模型调用统一经网关）；[ADR-0025](../../adr/ADR-0025-session-stream-addressing.md)（复合地址）；[01 稿](01-session-stream.md)；[research/01](../research/01-dsh-data-flow-survey.md) §4

## 1. 目标

让长会话在**不改动一个原始事件**的前提下，把模型可见的上下文折叠成"摘要 + 最近若干条"。压缩是账本里的一条持久事实，可审计、可重算、可还原；摘要生成走既有模型治理链，计费/超时/失败一条不少。

## 2. 事实核对（带证据）

- **F1 预留形状装不下**：`SurfaceOp` 只有 `kind/fromSeq/toSeq/note`（`packages/core/src/events.ts:356-365`），没有摘要正文、调用引用、版本。
- **F2 白名单封闭三类**（同文件 :81）；扩成员按 ADR-0021 决策 3 走 ADR。
- **F3 投影是纯 fold**（`packages/core/src/surface.ts:45-85`），只翻译不筛选。
- **F4 模型调用必须经网关**：`MODEL_INVOKED` + `MODEL_USAGE` 成对、预算预扣/结算（ADR-0003；Phase 4 切片③的证据链）。
- **F5 账本不允许向已终结的 run 追加**：已有账本的 run 拒绝第二写者（`packages/core/src/ledger.ts:279-286`）。**这条事实决定了压缩命令的形状**（§4）。
- **F6 DSH 的压缩是视图操作**：摘要事件带 `shadowedSeqs`，原始事件永留（research/01 §4）。
- **F7 会话上下文上限**：DeepSeek 侧上下文 1M token（research/02 §2）；Keel 不把厂商上限写死，阈值可配。

## 3. 事件形状与投影（S6）

```ts
/** 新表面事件（白名单第四类）。原始事件永不改删，本事件只描述"视图怎么折叠"。 */
interface SurfaceCompactedPayload {
  summary: string; // ≤ 8KB，超限拒绝写（不截断、不静默）
  shadowed: Array<{
    from: { runId: string; seq: number }; // 闭区间
    to: { runId: string; seq: number };
  }>;
  reason: "manual" | "threshold";
  usageRef: { reqId: string }; // 指向本次摘要调用的 MODEL_USAGE.reqId
  projectionVersion: number; // 写时为当前 SURFACE_PROJECTION_VERSION
}
```

- **白名单**：`SURFACE_EVENT_TYPES` 三类 → 四类（`SURFACE_COMPACTED` 加入）。
- **投影规则（两遍）**：
  1. 先收集全部压缩标记，展开 `shadowed` 的复合区间为"被遮蔽地址集合"。
  2. 再按会话顺序遍历：被遮蔽的地址跳过；标记自身若被更晚的标记遮蔽，则连摘要一起丢弃（**最新摘要为准**）；未被遮蔽的标记在该位置发出 `{role:"system", content:summary}`。
- **`includeCompacted:true`**：忽略所有标记与遮蔽，重算出未压缩视图——这就是"可还原"的机械定义。
- **`surfaceOp` 保持预留**，不参与压缩（ADR-0026 若选 B）；若选 A，则本节改为"标记 = 带 `surfaceOp` 的 `TURN_INPUT`"，投影需要在该事件上做特例，其余规则不变。

### 3.1 遮蔽区间的选择（写时算，读时不猜）

- 以**消息组**为最小单位：一条 `MODEL_MESSAGE`（带 `toolCalls`）加上紧随其后的全部 `TOOL_RESULT` 是一组；组不可被切开（切开会得到"有调用没结果"的非法上下文）。
- 保留最近的 `keepRecent` 条消息（默认 6，`--keep-recent` 可配）；从尾部向前累计到 `keepRecent` 且停在组边界，之前的全部纳入遮蔽区间。
- 首次出现 `role:"system"` 的输入（会话的固定提示）永远保留，不进遮蔽区间。
- 没有可遮蔽内容（不足 `keepRecent` 或遮蔽后不减少）→ **不写标记**（幂等 no-op）。

## 4. 触发与命令形状（受 F5 约束的修订）

**压缩只能是"下一次 run 的一部分"**，不能单独追加到已终结的 run。因此：

| 触发 | 形状                                                                                           | 说明                                                              |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 手动 | `keel run --session S --compact`                                                               | 在本次 run 首轮之前强制执行一次压缩                               |
| 阈值 | 自动：本次 run 启动时读会话里最近一次 `MODEL_USAGE` 的 `inputCached+inputUncached ≥ threshold` | `--compact-threshold` 可配，默认 128000（产品默认，不是厂商上限） |

- 不提供独立的 `keel compact` 命令（**2026-11-04 修订合同 §6 S8 / §4 的 CLI 清单**：账本 append-only 且拒绝重开已终结 run，独立命令无处落标记）。
- 时序（`beforeFirstRound` 缝）：`RUN_STARTED` → `ASSEMBLY_RECORDED*` → **摘要调用（`MODEL_INVOKED`/`MODEL_USAGE`）→ `SURFACE_COMPACTED`** → `TURN_INPUT`（本次输入）→ 首轮。这样视图顺序是"摘要 → 本次输入"，且本次输入永不被遮蔽。

## 5. 摘要调用的治理（E3 的核心）

- **模型**：缺省用本 run 引擎声明的模型；`--summary-model` 可换（必须是本 profile 已注册的模型名，未注册整份拒绝）。
- **预算**：与普通模型调用同一条链——`budget.reserve` → 调用 → `budget.settle` → `MODEL_USAGE`；计入 session 预算；超支按既有 `overrun` 规则夹取。
- **超时/失败**：沿用网关三层治理；失败 = **不写标记**、不改变视图；run 继续（压缩失败不阻断任务），CLI 打印告警，退出码不变。
- **输入**：只喂 `projectSession(history, {includeCompacted:false})` 的结果——白名单之外的事件在结构上进不来（F3），并加一条测试断言"摘要请求里不出现治理字段"。
- **输出**：只用于 `summary` 字段；**永不进入 `DECISION.basedOn` / `throughSeq` / 任何治理判断**（机械断言：`SURFACE_COMPACTED` 不出现在 `basedOn` 列表里）。
- **密钥红线**：摘要调用与普通调用同一条密钥解析路径，无新增暴露面。

## 6. 可靠性、幂等与还原

- **幂等**：同一次 run 里 `beforeFirstRound` 只执行一次；重复对同一前缀压缩会因"没有新的可遮蔽内容"变成 no-op，不产生空标记。
- **嵌套压缩**：后写的标记遮蔽更早的标记（§3 规则 2），摘要以最新为准；原始事件与旧摘要事件都还在账本里。
- **还原**：`keel sessions show --session S --raw` 看全部事件；投影 API 的 `includeCompacted:true` 重算未压缩视图；两者都不改账本。
- **审计**：`usageRef` 指回摘要调用的用量事件；`reason` 分辨手动与阈值；`projectionVersion` 绑定折叠规则。

## 7. 体量与成本（S7）

- 压缩不删除任何字节；账本只增一条标记 + 一次摘要调用的两条事件。**留存删除/GC 不在本阶段**（backlog）。
- 压缩会打断 DeepSeek 的 KV cache 前缀，下一次输入命中率下降——bench 只观测记录（`compaction` 段：摘要调用耗时/费用、压缩后首轮输入 token），不设阈值。
- 阈值默认 128000 是产品保守值；厂商上下文 1M（research/02 §2）不写进代码常量。

## 8. 验收映射（E3）

| 断言                                                            | 落点 |
| --------------------------------------------------------------- | ---- |
| 摘要调用有 `MODEL_INVOKED` + `MODEL_USAGE`，且预算预扣/结算成对 | §5   |
| 无旁路调用：账本里每次模型调用都能在网关事件里找到              | §5   |
| 投影折叠区间、原始事件全在、`includeCompacted:true` 可还原      | §3   |
| 摘要输入不含治理事件（白名单 + 断言）                           | §5   |
| 压缩失败 = 无标记、视图不变、run 正常收尾                       | §5   |
| 消息组不被切开（无"有调用没结果"）                              | §3.1 |

## 9. 风险与待决

- 风险 1：摘要质量不可控（编造/丢关键约束）——只进视图、原文永留、可还原；`reason` 与 `usageRef` 让审计能追到那次调用。
- 风险 2：阈值触发依赖"上一次调用的输入 token"，首次调用前无用量 → 不触发（合理：还没有上下文）。
- 风险 3：`summary` 过长（> 8KB）被拒 → 本次不压缩，run 继续；不做二次摘要（会再花一次调用且不保证收敛）。
- 待决：摘要模型是否应允许与引擎模型不同（本稿允许但默认同模型）；若所有者要求"压缩即换模型"，属于本阶段内的配置项，不扩语义。
