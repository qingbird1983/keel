# P-014-自研 Schema 子集把“动态键映射”当成已支持（其实是静默不校验）

> 单篇 ≤ 80 行；已检索 P-012/P-013（观察/样本科学校准），本篇只管**自研校验器的关键词支持边界**。

## 现象

为 manifest 设计 `governance.tools` 时，第一版形状是“对象映射”（工具名 → 切面）。Schema 里写：

```json
"tools": { "type": "object", "additionalProperties": { "type": "object", "required": ["name"] } }
```

结构上看起来完全合法。但本仓库的 `schema-validator.ts` 是**关键词子集**实现：`additionalProperties` 只在值为 `false` 时生效；值为对象 Schema 时既不校验、也不报“不支持”。于是任意形状的映射值都能通过结构校验，错误被推迟到装配器或运行期，甚至完全漏掉。

## 根因

关键词“在 `SUPPORTED` 集合里”不等于“所有取值形态都实现了”。`additionalProperties` 被列入支持集合，是因为 `additionalProperties: false` 是既有 Schema 的常用形态；对象形态从未实现，却也没有被拒绝——**未知取值形态被当成已知关键词放过**，这是校验器最危险的静默漏检类型。

## 修复

1. **Schema 设计改为数组 + 语义校验**：`governance.tools[]` 用 `name` 字段，工具名唯一性由装配器校验（`additionalProperties` 对象形态用不上，也不需要扩校验器）。
2. `packages/host/src/schema-validator.ts`：`additionalProperties` 非布尔值直接返回 `additionalProperties must be a boolean; object-valued schemas are unsupported`，把“静默忽略”变成“明确拒绝”。
3. 测试固化：`packages/host/test/schema-validator.test.ts` 新增对象形态拒绝 + 布尔 `true` 放行两条。

## 预防

- 给自研 Schema 校验器加**取值形态断言**，而不只断言关键词存在：每个支持的关键词至少一条“该关键词的合法形态通过 / 非法形态明确报错”。
- 设计公开 Schema 时，优先用**数组 + 装配器语义校验**表达“动态键集合”；既避开 `additionalProperties: {schema}`，也让重复键/空项等约束能给出可读错误。
- 判据：Schema 里出现 `additionalProperties` 时，只允许 `true` / `false`；需要值 Schema 就先扩校验器（并配负样本），再改 Schema。

## 归属

Phase 3 切片③（2026-11-03）；有代码改动（`schema-validator.ts` + 测试）；新设计见 [ADR-0015](../../docs/adr/ADR-0015-manifest-governance-and-cell-aop.md) §1 与 [04 稿](../../docs/design/phase-3/04-cell-runtime-aop.md) §4.2。
