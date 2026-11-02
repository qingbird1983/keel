# fixture：账本回放组 / replay-basic

- 来源：按契约（docs/design/phase-1/01-core-api-contract.md §5）信封手工构造的最小 Run 账本样例
- 日期：2026-11-02
- 用途：验证账本格式跨实例重放稳定——"旧样例可读且语义不变"（standards/05 §2.3）；账本 JSON 行格式一经定稿，历史样例必须持续可读
- 结构：`<agentId>/<sessionId>/<runId>/seg-000001.jsonl`，4 条事件（含 1 条 CHECKPOINT 一致点）
