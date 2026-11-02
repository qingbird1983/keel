# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-02（会话主题：Phase 1 切片③落地——Cell 运行时 + Host 装配，A2/A5 实现主体）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 🔄 进行中（tag `phase-1.start`）**——切片①②③ 已落地；施工顺序唯一来源：`docs/roadmap/phase-1-mvp.md`
- 已落地：工具链脚手架 + core 七组件（切片②）+ cell-runtime（帧协议/进程体/EFFECT_DECLARED 发起端）+ host（IsolationProvider/Supervisor/装配器五步校验/热装配回退）（切片③），**147 测试全绿，六道门禁绿，零运行时依赖**
- 验收进度：A2 主张已测试化（真实进程崩溃隔离，`tests/cell-crash.test.ts`，3 次复跑稳定）；A5 结构/回退/C-M1 焊点在 host 单测；N1~N5 manifest 遗留全部收口（契约/manifest 稿 2026-11-02 注记）

## 上一轮完成了什么（3~5 条）

- cell-runtime：FrameConn（契约 §3.1 帧形路由/超时/坏帧 fail-stop）+ startCell（私有工具表 + toolCallTimeoutMs 硬强制 + CellClient 可见面客户端）+ main.ts 进程入口（未捕获异常 = 非零退出）
- host：进程后端 + Supervisor（生命周期/退出三分类/失控强杀）+ 装配器（五步校验 + 零依赖 Schema 子集校验器 + semver 范围协商）+ 热装配（迁移钩失败回退旧作用域）+ serveCellChannel（scope/runId 服务端盖章，C-M1 焊点）
- core 小缝：Scheduler.abort（与 cancel 对偶，abort→RUN_FAILED；在途轮先收束）+ ASSEMBLY_RECORDED 作 run 首事件 + CONTRACT_VERSION="1.0.0"
- 设计稿增量：契约 §4.1 注记④⑤、§5 +ASSEMBLY_RECORDED；manifest 稿 N1~N5 定案 + schema 两处修订（policy templates 空 / policy、observation 禁 migration）
- A2 集成测试（真实进程）+ fixtures 两插件；eslint fixtures 全局、root devDeps @keel/*、.gitignore + .zcode/

## 下一步（按优先级，注明阻塞项）

1. **切片④**：补偿执行器（状态机 T01~T14 + 幂等重派 + 升级豁免）+ recover.plan/execute + 快照持久化（STATE_SNAPSHOT_REF）+ context 换页原语——A3/A4/A6 主体（阻塞：无）
2. 切片④后：A8 基准（账本吞吐/网关延迟/Cell 冷启动）+ fixtures 三组收全 + apps/keel CLI（验收执行入口，A2/A5 由 CLI 复演）
3. 远端仓库配置（阻塞：所有者提供地址）

> 实现中发现契约缺陷 → 先改设计文档（带日期注记）再改码；scheduler 的补偿缝/Supervisor 快照槽已为切片④留好注入位。

## 未决问题

- git 远端（所有者）；版权署名占位（LICENSE + 两 README + ADR-0006 四处，所有者决定）
- model.stream 流式通道未实现（契约 §4.7；无验收场景依赖，基准期回填）
- 旧 Cell drain 完整语义（在途 run cancel 后收束）随切片④恢复链路接入（AssemblyManager 只换绑，处置归调用方）
- policy 插件未接 HookBus 装配链（manifest hooks 字段仅校验）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Windows 子进程 exit 事件滞后 stdout 关闭数十 ms**——进程死亡第一信号 = 流关闭；受控 kill 用 killRequested 标记判定 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **seq 是 Run 内单调**（H-011）；恢复/延续一律用新 runId；read 未知 runId = LEDGER/CURSOR-INVALID
- 调度器是轮内事件唯一编排者（gateway 直写 MODEL_* 是先例；effect.declare 同法）；abort/cancel 对偶：cancel→RUN_HALTED、abort→RUN_FAILED，已终态幂等 no-op
- cell 侧不持有 scope/runId（宿主服务端盖章，防伪装）；Cell↔Run 1:1（attachRun 绑定）
- hook 缺席不留痕；hook③ fallback=give-up；装配器 schema 注入式传参（库不硬编码 docs 路径）
- typescript 锁 ^5.9；tsconfig.base 锁 ES2022（无 Promise.withResolvers，手动 deferred）
- 踩坑索引：[pitfalls/](pitfalls/)（P-001）
