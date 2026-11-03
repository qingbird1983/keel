# H-033 · 切片⑤：Phase 3 验收收口

- 日期：2026-11-04
- 前置：H-032（切片④三件套闭环）；合同 §7 注记"切片⑤不另立设计稿，修订直接落 manifest 稿/ADR"

## 本轮做了什么

1. **规范回填复核**（只读对账 → 两处缺口补注记，均带日期、无 schema 变更）：
   - 契约 §4.8：hook① 入参形状 `{tool, paramsDigest}` 未记，且 `paramsDigest` 在 toolApproval 通道承载**明文 params**——补注记（不改名：账本字段对齐）。
   - manifest 稿 §5.5：R4 生命周期（可选 `setup(ctx)`/`dispose`）未进规范——补注记：运行面不是报关单面，manifest 无对应字段。
   - 其余复核项无缺口（governance/trust/收据/WORKSPACE 错码均已在 R1~R5 期间回填）。
2. **C1~C7 逐条复核打勾**（合同 §5）：C1 补勾（切片②已达成未登记）+ 注记；C5（cell-crash + R5 隔离）、C6（audit-replay ①~⑤ + throughSeq + C4 联装归因）、C7（门禁 + 内核测试保留 + 零依赖双判）补勾。
3. **B6 插件开销基准**（cmd-bench.ts，合同"其他"交付物）：三行同族口径直连往返 N=20——echo 0.1~0.2ms（零治理对照）/ write_file 1.2~1.4ms（治理满配）/ toolApproval 跨进程 0.2ms。**坑**：首版把 wirePolicies 的 bindings 丢弃，策略舱 stdio 管道挂住 node 退出——90s 那次"成功"其实是 timeout 杀进程（EXIT=0 是管道尾 head 的）。修：保存 bindings + drainAndReap，验证干净退出。
4. **Phase 3 报告**（`docs/design/phase-3/report.md`，对齐 Phase 0/1 形态）+ docs/README 登记。
5. 收口：CHANGELOG 0.1.049；看板（00-roadmap + 合同）；本 handoff（滚动删 H-028）。

## 验证

- 六道门禁全绿：format / lint / typecheck / build / test（56 文件 420 测试）/ check-size（docs 60/150）。
- bench 干净退出（EXIT=0，修复后复跑两轮数字同量级）。

## 关键事实（后续会话别踩）

- **bench 的 `keel bench` 整跑约 40~60s**（Windows；B1 2000 append + B5 真进程流式占大头），管道里 `$?` 是管道尾命令的退出码——验证"进程是否干净退出"要直接看 node 的退出码（`node ... > out; echo $?`）。
- 策略舱收尾归调用方：`wirePolicies` 返回的 bindings 必须逐个 `drainAndReap`（`closeRuntime` 只收 rt 自己绑的）。
- C1~C7 证据索引在合同 §5 各打勾注记里；报告 §2 有 B6 数据。

## 遗留与下一步

- **待所有者**：`phase-3.end` tag（报告 §结论已声明具备条件）；业务层插件/多 Agent 编排已按合同移 Phase 4/backlog。
- Phase 4 未立项——若开阶段，先走合同定稿（两道闸）。
- 老项（未触发勿动）：根 `tests/` 类型检查缺口、standards/07 验收节补"交付物表逐条核对"、CI checkout 版本、ADR-0010 回滚与共享分区注册（冻结）。

## 已提取的沉淀

- 本轮无新 pitfall（B6 收尾问题沿用 P-003 的既有教训"收束覆盖所有 spawn 源"，已在 handoff 记录应用实例）。
