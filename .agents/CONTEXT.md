# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**切片⑤ Phase 3 验收收口，阶段报告定稿**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（ADR-0014 提前收口）/ **Phase 3 ✅ 五片切片全部完成**：验收 C1~C7 逐条复核全过（三条一票否决项达成），[阶段报告](../docs/design/phase-3/report.md) 定稿
- **等待所有者决定：`phase-3.end` tag**（报告结论已声明具备条件；业务层插件/多 Agent 编排已按合同移 Phase 4/backlog）
- 本轮交付：规范回填复核（两处注记）+ C1~C7 打勾 + B6 插件开销基准 + 报告 + 收口四件
- 六道门禁全绿：format / lint / typecheck / build / test（**56 文件 420 测试**）/ check-size（docs 60/150）
- 切片⑤提交在分支 `feat/phase3-slice5-closeout`（未 merge）；切片④已 merge（`316ef94`）

## 本轮实现了什么

- **规范回填复核**（无 schema 变更，两处带日期注记）：契约 §4.8 hook① 入参形状（`paramsDigest` 承载明文 params——插件作者须知）；manifest 稿 §5.5 R4 生命周期导出面（`setup`/`dispose` 是运行面不是报关单面）。
- **C1~C7 复核**：C1 补勾（切片②已达成未登记）；C5（cell-crash + R5 隔离）、C6（audit-replay + throughSeq + C4 联装归因）、C7（门禁 + 内核测试保留 + 零依赖双判）补勾；证据索引全在[合同 §5](../docs/roadmap/phase-3-native-ecosystem.md) 注记。
- **B6 插件开销基准**（`keel bench` 新增段，只测不设阈值）：echo 全链 0.1~0.2ms（零治理对照）/ write_file 治理满配 1.2~1.4ms / 策略插话跨进程 0.2ms——治理代价可量化且小。
- **修复**：B6 段 `wirePolicies` bindings 未回收 → 策略舱 stdio 管道挂住 node 退出；保存 bindings + `drainAndReap`，bench 干净退出（EXIT=0）。
- **Phase 3 报告**：`docs/design/phase-3/report.md`（对齐 Phase 0/1 形态：验收表 / 规范复核 / 体量 / 已知问题 / 文档清单）。

## 关键决策口径（别改错）

- **`phase-3.end` 是所有者的决定**，不是 AI 收尾动作——报告只声明"具备条件"。
- **切片⑤不另立设计稿**（合同 §7 注记）：修订直接落 manifest 稿/契约（带日期注记）；本轮两处注记均无 schema 变更、无新 ADR。
- **策略舱收尾归调用方**：`wirePolicies` 返回的 bindings 必须逐个 `drainAndReap`；`closeRuntime` 只收 rt 自己绑的舱（P-003 的应用）。
- **验证"进程干净退出"看 node 本身的退出码**（`node ... > out; echo $?`），管道里 `$?` 是管道尾命令的。
- 沿用口径：三件套分工（转正 B 只 write_file；fixture = 机制样例）；策略规则在代码；`paramsDigest` 不改名；AOP 不是沙箱；收据才是事实。

## 已验证 / 未验证

- 已验证：bench 干净退出（两轮同量级）；C1~C7 证据全部指向主线测试文件；56 文件 420 测试；六道门禁。
- 未验证/未做（Phase 3 范围外，backlog 触发条件不变）：OS 级三方插件隔离（容器/命名空间）、`fs.restore`/递归删除/网络撤销、Node permission audit 差异收集、符号链接 TOCTOU 彻底消除。
- 老项（未触发勿动）：根 `tests/` 类型检查缺口、standards/07 验收节补"交付物表逐条核对"、CI checkout 版本、ADR-0010 回滚与共享分区注册（冻结）。

## 下一步（按优先级）

1. 切片⑤提交 merge（分支 `feat/phase3-slice5-closeout` 就绪）。
2. **等所有者打 `phase-3.end` tag**（或给 further 意见 → 按意见修订报告/打勾注记）。
3. Phase 4 未立项：若开阶段，从合同定稿（两道闸）开始，不预设范围。

## 关键提醒（坑/规范/易错点）

- **测试收集范围少一层 glob = 测试静默不跑**：[P-016](pitfalls/P-016-测试收集范围少一层glob等于测试静默不跑.md)；报告数字同时报文件数。
- **投影不是镜像**（P-015）、宿主装配时序（P-002）、真子进程栅栏（P-006）、红测先行/绿色验真（P-007）、跨边界序列化（P-009）、中文文案 ASCII 引号（P-011）、自研 Schema 动态键（P-014）。
- 文档红线：ADR 只增不改（日期注记可）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 非技术且新在前；handoff 滚动 5 份（现 H-029~033）。
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-016）；方法索引：[skills/](skills/README.md)（S-001）。
