# P-024 profile 的插件 scope 在装载期就固化，装配后改 plan.scope 不生效

## 现象

`keel run --profile P --session S` 最初在 `loadProfile()` 之后改 `plan.scope.sessionId = S`：
run 的 `ref.sessionId` 变成了 S，但插件 Cell 的 scope 仍是清单里的默认值（如 `main`）。
表现是"会话目录里开出了 run，但工具分区/授权主体按另一个 session 计算"——续跑时历史与执行面对不上，而且是静默的。

## 根因

`loadProfile` 在装载期就把顶层默认值**逐插件物化**成 `plugins[].scope`：

```ts
scope: {
  agentId: p.scope?.agentId ?? scope.agentId,
  sessionId: p.scope?.sessionId ?? scope.sessionId,
}
```

装配器（`assembleProfile`）只读 `plan.plugins[].scope` 与 `plan.scope`，**不会回头重算**。
所以"先装载、再改 plan.scope"只改到 run 这一半，插件那半仍是旧值。

## 修复

运行期覆盖必须走**装载期**的选项：`loadProfile(path, { ..., sessionId })`，由它作为顶层缺省值参与逐插件物化；
插件自己显式写了 `scope.sessionId` 的仍以插件为准（不覆盖显式声明）。

## 预防

- 要覆盖清单里的任何默认值，先判断它是在**装载期**还是**装配期**固化：装载期固化的东西只能在 options 里改。
- 新增"运行期覆盖"类参数时，写一条真进程用例断言"run 的 scope 与插件 Cell 的 scope 一致"，不要只断言 runId/目录。
- 同类风险面：`agentId` 的覆盖（当前没有 CLI 入口）、插件级 `scope` 覆盖（本来就以插件为准）。
