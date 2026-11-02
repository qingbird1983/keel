# H-014-切片⑤CLI验收入口A8基准与fixtures收全

- 日期：2026-11-02
- 范围：Phase 1 切片⑤（apps/keel CLI 七命令 + A8 基准 + fixtures 三组收全 + keel replay 最小实现）

## 本轮做了什么

1. 设计稿先行：新稿 `04-cli-benchmarks-fixtures.md`（CLI 七命令面 / A8 四项基准口径 / fixtures 收全清单 / 六条实现期定案，所有者四项决策全选推荐：bench 子命令、scenario 一键复演、纳入最小 replay、validate+hotswap）；01 稿 §9 基准口径注记、02 稿 §13 桩组收全注记、03 稿 §8 负路径 fixtures 注记、docs/README 登记 04 稿与 report
2. apps/keel 薄壳落地（9 文件 1441 行，最大 cmd-scenario.ts 406）：runtime.ts 装配共享（buildRuntime/wireRun，接线序 = tests/ 三份集成 rig 同构，onCheckpoint 快照缝 + 补偿 Cell 工厂缝 + 告警收集）+ 七命令（run/recover/replay/validate/hotswap/bench/scenario）+ main.ts 分发
3. fixtures 三组收全：schema 负路径组 6 枚（§8 四类实体化 + 2 结构负例，host 批量校验测试全拒）；账本回放组 +3 样例（决策序列 22 事件 A6 复演样例 / 跨段 seq 连续 / 撕裂尾负例，core 测试断言语义不变）；补偿桩组 +3 handler（always-slow / dedup-keyed / mitigate）+ dependsOn 透传 + migration-fail 桩
4. A8 基准：`keel bench` 四项采集 → `docs/design/phase-1/report.md`（B1 吞吐 24028 events/s、B1b 一致点 0.86ms、B2 网关 ~0.2ms、B3 冷启 ~40ms、B4 编排 ~1ms；初读 = 三个 ADR 重评条件均无触发迹象）
5. keel replay 最小实现（A6 入口）：纯读 + 按事件类型单行归因摘要，决策序列 fixture 复演验证
6. report.md 立档：A8 数据 + 契约 §9 五测试点逐条核对（均有测试背书）+ A1~A8 覆盖方式指引

## 验证

- 六道门禁全绿；208 测试 / 26 文件（191 → +17：assembler 负组 +7、ledger 回放 +3、compensator timeout/mitigable +2、CLI 冒烟 +5）
- `keel scenario a2|a3|a4|a5` 全 PASS，a3/a4/a5 3 次复跑稳定（a2 在 CLI 冒烟测试常态跑）
- 单文件最大 406 行（cmd-scenario.ts）；apps/keel 总 1441 行；check-size 0 提醒

## 关键实现决策（评审锚点）

- **scenario 断言语义** = 账本事件存在性检查（不复制包语义）；A4 场景在集成三路径外加第 ④ 路径 keyed 去重桩（resultDigest{dedup:true,calls:1}）
- **probe/builtin 桩不收**：执行器侧未实现（backlog），桩先行即死资产——设计稿 §4 明文
- **一次性命令 vs 跨会话命令的数据目录分治**：run/hotswap/bench/scenario 用自动清理临时目录；recover/replay 必传 --data-dir（04 稿 §2 通用约定，同日修订与实现对齐）
- **AssemblyManager spawn 的 Cell 不经 wireRun bindings**：收束责任在调用方——hotswapDemo 以 Set 追踪 + finally dispose（否则子进程吊住 CLI 不退出）
- **bench 各段独立 runId**：冷 Ledger 实例不允许向已存在账本的 run 接笔（LEDGER/WRITE-FAILED），跨实例共用 runId 即触雷

## 遗留与下一步

- Phase 1 施工清单已全部落地；下一步 = **阶段验收**：逐条执行 A1~A8（scenario 已覆盖 A2~A5，A1 并发规模 / A6 任选真实 Run 归因留验收周执行）+ report.md 收口 → 翻牌 `phase-1.end`
- backlog 不变：probe 通道、builtin 补偿动作、快照物理持久化、退避参数可配置面、migration 多步链、未决污染清单 CLI、model.stream、policy→HookBus 装配链、旧 Cell drain 完整语义
- git 远端与版权署名仍待所有者

## 已提取的沉淀

- 资源收束要覆盖所有 spawn 源 + 冷实例接笔保护 + 依赖材料先于组件构造 → pitfalls/P-003
