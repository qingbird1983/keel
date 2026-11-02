# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 1 切片①——core 记账与裁决基座：账本/授权器/预算器）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 🔄 进行中（tag `phase-1.start`）**——切片① 已落地；施工顺序唯一来源：`docs/roadmap/phase-1-mvp.md`
- 已落地：工具链脚手架（六道门禁全绿）+ `packages/core` 的 ledger / authorizer / budget（31 测试全绿，零运行时依赖）
- 版本控制：git main（本地无远端）；行尾已规范化（.gitattributes，LF）

## 上一轮完成了什么（3~5 条）

- ledger.ts：append-only 分段 JSONL + CHECKPOINT fsync 一致点 + fail-stop 锁存 + 尾部撕裂安全读 + 游标分页 + ID 信任边界 + close() 确定性释放
- authorizer.ts：fail-closed 白名单 + AUTH_DENIED 必留痕；budget.ts：两级额度 reserve/settle、同 id 幂等、耗尽三档上报
- events.ts 全事件表（契约 §5 + 状态机 §9）；glob 方言；fixtures/ledger/replay-basic 首个回放样例组
- .gitattributes 落地（standards/01 §1 已修订）：根治 autocrlf 假性全库改动；一次性 renormalize 随本轮提交

## 下一步（按优先级，注明阻塞项）

1. **切片②**：调度器（轮循环 + CHECKPOINT + 预算耗尽处置）、上下文管理器（scope 分区 + tool.discover）、模型网关（授权→预扣→代理→实结）、策略 hook 四件套——A1/A2/A7 实现主体（阻塞：无）
2. 切片③：cell-runtime（进程体 + stdio 帧）+ host（IsolationProvider / Supervisor / 装配器）——A2/A5
3. 切片④：补偿执行器（T01~T14）+ recover.* ——A3/A4/A6；随后 A8 基准 + fixtures 三组收全
4. 远端仓库配置（阻塞：所有者提供地址）

> 实现中发现契约缺陷 → 先改设计文档（带日期注记）再改码；契约待决细化项见 H-011。

## 未决问题

- git 远端（所有者）；N1~N5 manifest 结构遗留（随切片③装配器处理）
- 版权署名占位（LICENSE + 两 README + ADR-0006 四处，所有者决定）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **seq 是 Run 内单调**（实现期细化决策，H-011）；恢复/延续一律用新 runId（旧 run 禁止接笔）
- read 未知 runId = LEDGER/CURSOR-INVALID（寻址失败语义）
- 跨 Run 全量读取未开放（观测面落地时开放）；预算 settle 后 used=实际耗用
- typescript 锁 ^5.9（TS7 与 typescript-eslint 8 不兼容，附录 A 有否决理由）
- 踩坑索引：暂无独立 pitfalls 文件（险情记录见 H-009/H-010/H-011）
