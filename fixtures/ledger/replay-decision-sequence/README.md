# replay-decision-sequence —— A6 审计重放样例

一个 Run 的完整决策序列（22 事件，2026-11-02 切片⑤录制）：装配审计 → hook 介入
（HOOK_CALLED/HOOK_VERDICT）→ 拒绝留痕（AUTH_DENIED）→ 声明先行（EFFECT_DECLARED 先于
TOOL_RESULT）→ 预算权威记账（BUDGET_RESERVED/MODEL_USAGE/BUDGET_SETTLED 预扣实结）→
一致点（CHECKPOINT）→ 终态 + 补偿闭环（RUN_HALTED 后 COMPENSATION_EXECUTED 闭入旧 runId）。

用途：`keel replay` 复演样例（A6"从账本重放完整决策序列"的可读性主张）+ core fixture
回放组断言"旧样例可读且语义不变"（standards/05 §2.3）。payload 逐字段对齐
`packages/core/src/events.ts` 的载荷类型。
