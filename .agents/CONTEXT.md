# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 1 切片②控制面落地 + 仓库结构调整——实现/测试分目录）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 🔄 进行中（tag `phase-1.start`）**——切片①② 已落地；施工顺序唯一来源：`docs/roadmap/phase-1-mvp.md`
- 已落地：工具链脚手架（六道门禁全绿）+ core 七组件（ledger / authorizer / budget / context / gateway / hooks / scheduler，66 测试全绿，零运行时依赖）
- 包结构（2026-11-02 起）：每包 `src/` 仅实现 + `test/` 仅测试；typecheck 用 `tsconfig.json`（含 src+test）、build 用 `tsconfig.build.json`（仅 src）；约定成文 standards/05 §1、04 §6、01 §2 预设 B
- 版本控制：git main（本地无远端）；行尾 LF（.gitattributes）

## 上一轮完成了什么（3~5 条）

- 仓库结构调整：12 个测试文件迁至 `packages/*/test/`（git mv 保留历史），root vitest include 同步；构建产物不再含测试代码
- 五包 README 落地（core 组件表/不变量落点，占位包如实标注状态与预计切片）；包级不设 CHANGELOG（进展流水唯一在根 CHANGELOG）

- scheduler.ts：轮循环固定序列（ROUND_STARTED→读上下文→DECISION+hook②→执行→CHECKPOINT→ROUND_ENDED）；耗尽三档处置（hard-stop→RUN_FAILED / graceful→RUN_HALTED / policy→hook④）；hook③ 重试钳制 ≤3 次、退避 ≤30s；cancel 语义（停派发新轮，在途轮收束）
- context.ts：scope 分区 + tool.discover；TOOL_SCHEMA_CHANGED 经 scope 级挂起日志 + 各 run 游标传播（同 scope 多 run 不丢事件）；换页原语顺延（契约已注记）
- gateway.ts：授权→预扣→代理→实结；同 reqId 重放返回缓存不重打上游；上游失败 settle(0) 全退，重试派生 `reqId#n` reservation（修掉 settle-once 吞实结的缺陷）
- hooks.ts：四 hook 白名单 + 响应封闭键集校验（V6 禁区）+ 超时/异常/schema 违规一律 fallback 留痕
- 契约 §4.1/§4.3/§4.6 补三条 2026-11-02 实现期注记（正常完成事件映射、重试派生预扣、换页顺延）

## 下一步（按优先级，注明阻塞项）

1. **切片③**：cell-runtime（进程体 + stdio 帧）+ host（IsolationProvider / Supervisor / 装配器五步校验）——A2/A5 实现主体；N1~N5 manifest 结构遗留随装配器处理（阻塞：无）
2. 切片④：补偿执行器（T01~T14）+ recover.*——A3/A4/A6；随后 A8 基准 + fixtures 三组收全
3. 远端仓库配置（阻塞：所有者提供地址）

> 实现中发现契约缺陷 → 先改设计文档（带日期注记）再改码；scheduler 的 ToolExecutor/补偿缝已为切片③④留好注入位。

## 未决问题

- git 远端（所有者）；版权署名占位（LICENSE + 两 README + ADR-0006 四处，所有者决定）
- model.stream 流式通道未实现（契约 §4.7；无验收场景依赖，基准期回填）
- context.page.out/in 换页原语顺延（契约 §4.6 注记；Phase 1 收官前需落地或登记豁免）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **seq 是 Run 内单调**（H-011）；恢复/延续一律用新 runId（旧 run 禁止接笔）
- read 未知 runId = LEDGER/CURSOR-INVALID；跨 Run 全量读取未开放
- 调度器是账本唯一写入者；gateway 重试派生 `reqId#n` reservation（settle-once 语义不动）
- hook 缺席不留痕（无介入即无事件）；hook① fallback=approve（仅否决权语义）、hook④ fallback=hardStop
- typescript 锁 ^5.9（TS7 与 typescript-eslint 8 不兼容）；tsconfig.base 锁 ES2022（无 Promise.withResolvers）
- 踩坑索引：暂无独立 pitfalls 文件（险情记录见 H-009/H-010/H-011）
