# H-012-切片③Cell运行时与Host装配

- 日期：2026-11-02
- 范围：Phase 1 切片③（A2/A5 实现主体 + N1~N5 收口）

## 本轮做了什么

1. 设计稿先行（铁律 1）：契约 §4.1 注记④⑤（abort 缝 + CELL/* 原因码、ASSEMBLY_RECORDED 首事件）、§5 事件表 +ASSEMBLY_RECORDED；manifest 稿收口 N1~N5（policy templates 空、policy/observation 禁 migration、不引入独立 schemaVersion、$id 占位定案、§6 第 5 步落实）+ schema 两处修订（两示例仍过、jsonschema 负路径实测）
2. core 两处小缝：`Scheduler.abort(runId, reasonCode)`（与 cancel 对偶：abort→RUN_FAILED；在途轮先收束再落终态，round 末尾 cancelRequested 守卫）+ RunManifest.assembly → ASSEMBLY_RECORDED 作 run 首事件；CONTRACT_VERSION="1.0.0" 导出
3. cell-runtime（零依赖）：protocol.ts FrameConn（帧形路由/超时/坏帧 fail-stop/对端关闭）+ cell.ts startCell（私有工具表、toolCallTimeoutMs 硬强制、CellClient §3.3 可见面、effect.declare 发起端）+ main.ts 进程入口（bootstrap argv JSON；未捕获异常=非零退出，crash 分类前提）
4. host：ProcessIsolationProvider（killed 以主动 kill 标记判定，跨平台稳）+ schema-validator（draft 2020-12 关键词子集，注解词 title/description 单列；未知关键词报错防漂移）+ Assembler 五步校验（semver 范围 ^~/>=/裸精确）+ AssemblyManager 热装配（迁移钩失败→新 Cell 丢弃旧绑定不动；旧 Cell 处置归调用方）+ serveCellChannel（§3.3 强制：scope/runId 服务端盖章、filter.runId 覆盖、可见面外 op 拒）+ CellSupervisor（生命周期、退出三分类、失控强杀宽限、executor 通道绑定）
5. 集成测试 tests/cell-crash.test.ts（真实进程 A2）：崩溃 Cell RUN_FAILED{CELL/CRASH}、另一会话正常完成、账本互不可见；fixtures 两插件 .mjs
6. 工程件：host package.json + root package.json devDeps（@keel/* workspace，供 tests/ 解析）；eslint tests/fixtures 全局声明；.gitignore + .zcode/

## 验证

- 147 测试全绿（core 66 / cell-runtime 19 / host 61 / 集成 1），A2 集成测试 3 次复跑稳定
- 六道门禁全绿；单文件最大 245 行（600 红线内）；check-size 0 提醒

## 关键实现决策（评审锚点）

- **退出三分类的第一信号 = 通道关闭**：Windows 上 exit 事件滞后 stdout 结束数十 ms，等它则 run 在 abort 前跑完（实测复现）→ 通道关闭即通知宿主（killRequested 同步可知 → killed/crash 立即成立），exit 事件只补 waitExit 记录
- executor 通道死 = error-result 回落（不抛），终态统一由 abort 缝落 → 原因码确定可断言
- effect.declare 未声明模板拒绝码用 SCHED/MANIFEST-INVALID（准入域语义延伸）；未知 op 用 TRANSPORT/BADFRAME（帧语义层）
- 装配器 schema 内容由调用方注入（库代码不硬编码 docs 路径）；CONTRACT_VERSION 缺省取 @keel/core
- cell 侧不持有 scope/runId（宿主服务端盖章，防越界伪装）

## 遗留与下一步

- 切片④：补偿执行器（T01~T14）+ recover.* + 快照持久化（STATE_SNAPSHOT_REF）+ context 换页；随后 A8 基准 + fixtures 三组收全
- 快照 MVP = AssemblyManager 内存槽（迁移钩出入参）；持久化随切片④
- policy 插件未接 HookBus 装配链（manifest hooks 字段仅校验）；A2/A5 阶段验收由 apps/keel CLI 复演

## 已提取的沉淀

- Windows 子进程事件序坑 → pitfalls/P-001（exit 事件滞后于 stdout 关闭）
