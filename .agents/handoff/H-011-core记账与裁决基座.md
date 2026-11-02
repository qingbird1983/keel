# H-011：core 记账与裁决基座（切片①）

- 日期：2026-11-02
- 分支：`feat/core-foundation`

## 本轮做了什么

- `packages/core` 落地三组件（零运行时依赖不变）：
  - **ledger.ts**（323 行）：append-only 分段 JSONL（段边界对齐一致点）、执行期 seq 分配（调用序=队列序=文件序）、CHECKPOINT fsync 一致点（ADR-0004）、fail-stop 锁存（写失败后该 run 全拒）、尾部撕裂行安全读、冷实例 lastCheckpoint 扫描、游标分页 read、ID 信任边界校验（防路径穿越）、`close()` 确定性释放句柄
  - **authorizer.ts**：fail-closed 白名单（`*` 通配 + 资源 glob），拒绝必写 AUTH_DENIED 事件
  - **budget.ts**：run+session 两级 reserve/settle，同 reqId 幂等不重复扣、同 reservation 只结一次、耗尽三档（hard-stop/graceful/policy）上报（派发处置归调度器，后续轮）
  - events.ts：契约 §5 + 状态机 §9 全事件表与载荷类型；glob.ts：`**`/`*`/`?` 方言
- fixtures/ledger/replay-basic：首批账本回放样例（standards/05 §2.3 兼容锚），ledger.test.ts 闭环验证
- **.gitattributes 落地**（`* text=auto eol=lf`）：根治 autocrlf=true 与 prettier LF 的假性全库改动；standards/01 §1 根文件清单已同步修订（一次性 renormalize 随本提交）

## 验证

- 门禁六连全绿；测试 31/31（ledger 9：含崩溃安全/段滚动/游标/追加序保护；authorizer 5；budget 9；glob 4；出口 1；骨架冒烟 3）

## 关键实现决策（后续轮要知道）

- **seq 为 Run 内单调**（契约未明说，实现期细化）：单写者下免全局锁；DECISION 依据引用、recover 一致点均按 run 内 seq 语义
- **read 未知 runId → LEDGER/CURSOR-INVALID**（寻址失败语义）；冷实例禁止向已有账本的 run 接笔（追加序保护，恢复一律新 runId）
- 预算单位为抽象计量（number）；settle 后 used = 实际耗用（非预扣额）
- 跨 Run 全量读取（观测插件）未开放——shortcut: 随观测面落地开放

## 遗留与下一步

1. 切片②：调度器（轮循环+CHECKPOINT+耗尽处置）、上下文管理器（scope 分区+tool.discover）、模型网关（auth→reserve→代理→settle）、策略 hook 四件套 —— A1/A2/A7 的实现主体
2. 切片③：cell-runtime（进程体+stdio 帧）+ host（IsolationProvider/Supervisor/装配器）—— A2/A5
3. 切片④：补偿执行器（状态机 T01~T14）+ recover.* —— A3/A4/A6

- 已提取沉淀：无新 pitfall（FileHandle GC 问题属 standards/04 §3 既有规则的执行，已在 close() 落实）
