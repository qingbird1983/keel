# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-04（会话主题：**Phase 4 立项起草——DSH 数据流勘察沉淀 + 合同草稿待评审**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅（提前收口）/ **Phase 3 ✅ 切片⑤完成**（C1~C7 全过，报告定稿；`phase-3.end` tag 决定权仍归所有者，未打）
- **Phase 4 立项起草中**：[合同草稿](../docs/roadmap/phase-4-profile-engine-loop.md) 落盘（分支 `docs/phase4-charter`，未 merge），**等所有者逐行评审 + K1~K6 确认后转定稿**
- 设计输入已冻结：[research/01](../docs/research/01-dsh-data-flow-survey.md)（DSH 关键数据流勘察，checkout `8bd073392e`）——所有者确认的用途："每一步都有参照目标，防止跑偏"
- 本轮交付：勘察（3 个并行探索任务）→ briefs 对齐稿 → 沉淀 research/01 → 合同草稿 → 看板/文档地图/CHANGELOG 0.1.050

## 本轮关键结论（别丢）

- **方向（所有者确认）**：全插件（连桌面端也是插件）；按 DSH 方式逐步长；Phase 4 只圈 Profile 装配 + `kind:"model"` + `kind:"engine"`（headless 闭环），会话持久化/桌面壳与 ui kind/生态件留后续；**流向优先于结构**（结构是名词抄得对顶多难看，流向是动词错了功能原意就变，且错误有复利）
- **briefs 纪律教训**：所有者只指定读 `briefs/keel harness.md`（42 行，结尾截断在 profile.yaml 示例中间）；我顺手读了同目录其他草稿（02/03 全架构、ui-kind 提案）被带偏一轮（三层 Runtime/编排器/飞信件、UI 窄词表都是**作废草稿**）——**只读指定文档，别自由发挥**
- **勘察六条结论**（research/01 §2，设计稿必引）：①进程边界画在 durable 事件上不画在 delta 管道上（跨进程零 delta 通道）；②usage 是流内事件、计量=日志投影；③模型上下文=表面投影纯函数、压缩=视图操作；④下行治理四件套（ready 先行/白名单/整体投递或丢弃/Host 整值投影）；⑤挂起交互持久状态只有投影与日志、"超时不是批准"；⑥UI 插件 DSH 零进程隔离（Keel 沙箱是原创点、风险单列）
- **DSH 两条没做好**（Keel 必须自建）：模型调用无总超时/预算治理；UI 插件无进程隔离
- 之前会话已确认：engine 进 Cell（K2）；Phase 4 粒度 = 只圈①②③（K1）

## 已验证 / 未验证

- 已验证：勘察结论全部带 `文件:行号` 证据（锚 `8bd073392e` 快照）；六道门禁 56 文件 420 测试全绿（Phase 3 末态，本轮零代码变更）
- 未验证/未做：合同 K1~K6 未拍板；切片①三份设计稿未写；`keel harness.md` 截断处之后的内容所有者尚未补充（engine/model manifest 设想——不阻塞，设计稿阶段补）

## 下一步（按优先级）

1. **等所有者评审合同草稿**（逐行 + 🔴🟡🟢）：重点 §8 K1~K6——K1 范围 / K2 engine 进 Cell / K3 拓扑方向（统一流 vs 双日志，两案对比后所有者拍板）/ K4 真适配器策略 / K5 模型调用治理 / K6 禁面扩展
2. 评审意见 → 修订合同 → 定稿（K 确认记录进状态行，Phase 3 模式）
3. 切片①：三份设计稿（`docs/design/phase-4/01-profile-assembly / 02-model-kind / 03-engine-kind`）+ 拓扑 ADR + 契约/manifest 修订清单 + 禁面扫描扩展（每稿两道闸）
4. 提醒事项：`phase-3.end` tag 未打（所有者决定；切片②开工前应已打）；分支 `docs/phase4-charter` 待 merge

## 关键提醒（坑/规范/易错点）

- **文档红线**：ADR 只增不改（日期注记可）；docs/ 新增必须登记 `docs/README.md`（本轮已登记 2 份）；报告/handoff 不写本机绝对路径；CHANGELOG 非技术且新在前（本轮 0.1.050）；handoff 滚动 5 份（现 H-030~034 窗口，收尾时归档本轮）
- **briefs 生命周期**：brief 不是事实来源；对齐结论必须沉淀 docs/ 对应区域（本轮：facts→research/01，决策→合同草稿）；`briefs/dsh-data-flow-survey.md` 已被 research/01 取代，可随时清理
- **体量红线**：docs 预算上轮 60/150，本轮 +2 文档，收尾时跑 check-size 核对
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-016；P-015"投影不是镜像"是 Phase 4 桌面流设计的关键坑）；方法索引：[skills/](skills/README.md)（S-001）
- 设计稿写作纪律（合同 §4 已写）：凡借 DSH "流的形状"处写三栏（DSH 实况/Keel 对应/差异理由）；词汇表一次定稿修订走 ADR；禁面扫描扩展先于新标杆插件（K6）
