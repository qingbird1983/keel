# P-019-把 0 当成“缺省值”导致空 resources 的插件一装载就崩

## 现象

Phase 4 切片② 第一次给 `kind:"engine"` 起真进程时，装配器抛
`TRANSPORT/BADFRAME: cell not ready`，detail 里是 `cause: channel broken: peer closed channel`。
引擎夹具本身没有语法错误，Cell 却秒退。

## 根因

`packages/cell-runtime/src/main.ts` 的 bootstrap 前置检查写的是：

```ts
if (!boot.pluginPath || !boot.toolCallTimeoutMs) crash("incomplete bootstrap");
```

宿主对 `manifest.resources.toolCallTimeoutMs` 的缺省填充是 `?? 0`
（`supervisor.ts` 构造 bootstrap 时）。engine 的 `resources` 按设计必须是空对象，
于是 `0` 被当真值判断拦下——**一个合法的“我不受理 tool.exec”值被当成“参数缺失”**。
策略舱早就显式传 `0` 表示同一语义，却因为走的是另一个入口（`policy-main.ts`）
没有这个检查而一直没暴露。

## 修复

- 检查改为类型判断：`typeof boot.toolCallTimeoutMs !== "number"`；`0` 合法（engine/策略舱不受理工具执行）。
- 真进程红测：`tests/profile-assembly-e2e.test.ts` D1-a 用 engine 夹具起舱并取快照，
  在修复前必红（`cell not ready`），修复后绿。

## 预防

- **数值哨兵不要用 falsy 判断**：`0` / `""` / `NaN` 都是合法配置值时，用类型 + 显式范围检查，
  不用 `!value`。
- 新 kind 复用旧入口时，先问“这个入口对旧 kind 的缺省假设还成立吗”，
  尤其是“字段缺失时填什么”的 `??` 兜底值。
- 判据：入口对参数的校验只允许拒绝“类型不对/超出范围”，不允许把某个合法值当缺省。

## 归属

Phase 4 切片②（2026-11-04）；代码改动 `packages/cell-runtime/src/main.ts` + 真进程用例；
设计依据 [03 稿](../../docs/design/phase-4/03-engine-kind.md) E8（engine 不出网、无工具执行能力）。
