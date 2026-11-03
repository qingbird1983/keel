# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：**运行上下文重构 R1~R5 落地**）

## 当前阶段与状态（对照 roadmap 看板）

- Phase 1 ✅ / Phase 2 ✅ 提前收口（[ADR-0014](../docs/adr/ADR-0014-drop-legacy-ecosystem-compat.md)）/ Phase 3 🔄：切片① ✅、切片② ✅、切片③ ✅、**切片③.5 ✅（R1~R5，本轮完成）**
- 下一片 = **切片④（R6）**：插件 B（file-write 转正，纯 handler + workspace 收据，补 C3“未声明写当场拒绝、零部分生效”）+ 插件 C（param-guard，C4）；设计稿从 `08-*.md` 起编号
- 本轮交付：07 稿定稿 + [ADR-0017](../docs/adr/ADR-0017-runtime-context-layering.md) / [0018](../docs/adr/ADR-0018-effect-receipts-and-workspace.md) / [0019](../docs/adr/ADR-0019-trust-tiers-and-cell-isolation.md) / [0020](../docs/adr/ADR-0020-workspace-error-codes.md)；实现证据见 [07 稿 §13](../docs/design/phase-3/07-runtime-context-refactor.md)
- 六道门禁全绿：format / lint / typecheck / build / test（**51 文件 401 测试**）/ check-size（docs 58/150、.agents 24/40、产物 753KB）

## 本轮实现了什么

- **R2 运行上下文骨架**：新包 `@keel/runtime-context`（`EffectScope` LIFO、`RunContext` 冻结、`EffectReceipt`/`WorkspaceMode` 类型、Scope/RunRef 共享）；Core `ContextManager` 拆为 `ToolCatalog` + `PageStore`，旧名保留为**弃用门面**（只转发）；调度器/Cell 通道/CLI runtime 改用新类。
- **R3 效果收据与 Workspace**：`packages/host/src/workspace.ts`——`create` 用 `open("wx")` 独占、`overwrite` 显式；`path.resolve` + 父目录 `realpath` 双重 allow；拒绝 `..`/符号链接/非常规文件；Windows 大小写归一；收据 identity = `dev/ino/size/mtimeMs/sha256`。新通道 op `workspace.write`（授权 → 认领 effect → 写 → `EFFECT_SETTLED.receipt`）；`fs.remove` 只认 `created:true` 且 identity 相符；无收据/覆盖写跳过并告警。
- **R4 生命周期与幂等**：插件可选 `setup(ctx)`（`ctx.effect` 资源栈 + `ctx.tools.register` 动态工具）与 `export function dispose`；宿主 `cell.dispose` 正常收尾（模块 dispose → 资源 LIFO，幂等），`drainAndReap` 只对已就绪舱等待；调度器生成 `toolCallId`，`EFFECT_DECLARED.toolCallId` + `EffectTracker` 去重；重试复用 effectId/收据；多 effect 各自结算、未发生的不补偿。
- **R5 隔离与信任**：spawn 环境白名单（排除 `NODE_OPTIONS`、`*_TOKEN/KEY/SECRET`）；唯一 `fs.write` 根 = cwd；manifest `trust.rawIo` 申请 + 宿主 `allowRawIo` 授予（默认拒绝，授予写 `ASSEMBLY_RECORDED.trust`）；Node 权限模型仅 `nodePermissionArgs` 透传，默认关闭。
- **证据**：`tests/native-file-write-aop.test.ts` 10 例（自动声明/拒绝/注入失败/预存在/覆盖/逃逸/身份不符/重试/多 effect/env-cwd）；`tests/native-lifecycle.test.ts`；host 单测 workspace/收据/trust/env；全量 401 测试。

## 关键决策口径（别改错）

- **AOP 不是沙箱**：拦截器跑在插件进程；真正边界 = Cell 隔离 + manifest 授权 + 评审。raw IO 当前不被系统调用拦截，只是“受信 + 审计 + 不享受内置补偿”的标记。
- **声明 ≠ 事实**：`EFFECT_DECLARED` 是意图；`EFFECT_SETTLED.receipt` 才是事实。`fs.remove` 只认 `created:true` + identity 相符；覆盖写永不内建删除；无收据跳过（不升级、不误删）。
- **写文件唯一黄路径**：`ctx.workspace.create/overwrite`。直接 `fs.writeFile` 不产生收据，内置删除不会碰它。单 effect 自动绑定；多 effect 必须显式 `effectId`。
- **路径**：绝对路径 + resolve + 父目录 realpath 双重 allow；拒绝 `..`、符号链接、目录/设备文件；Windows 大小写归一。不在 allow → `AUTH/DENIED`；路径问题 → `WORKSPACE/PATH`；已存在 → `WORKSPACE/EXISTS`；IO → `WORKSPACE/IO`。
- **幂等**：同 `toolCallId` + kind + 稳定目标 → 复用 effectId；同 effect 已结算且有收据 → 返回既有收据，不重复写。
- **收据落账失败**：`Workspace.rollback` 尽力删新建文件；删不掉则错误可见（不伪装成功）。
- **残余窗口**：identity 复核与 unlink 非原子（Node 无 `openat`）；create 成功与收据落账之间进程猝死可能留无收据文件（不会被误删）；覆盖写无法恢复旧内容。
- **兼容**：旧账本无 receipt → 内建删除跳过（fail-closed）；旧 handler `(params)` / `(params,{client})` 仍可赋值；echo 无 governance；cordis 适配层不动。

## 已验证 / 未验证

- 已验证：R1~R5 全部实现路径 + 真进程证据；全量 401 测试；format/lint/typecheck/build/check-size。
- 未验证/未做：`fs.restore`、递归删除、网络通用撤销、二进制/流式写入、跨设备原子性、符号链接 TOCTOU 的彻底消除、Node permission audit 差异收集。
- 老项（未触发勿动）：根 `tests/` 类型检查缺口、standards/07 验收节补“交付物表逐条核对”、CI checkout 版本、ADR-0010 回滚与共享分区注册（冻结）。

## 下一步（按优先级）

1. 切片④（R6）：写 `docs/design/phase-3/08-plugin-b-c.md`（两道闸）→ 插件 B 用 `ctx.workspace` + 收据补 C3；插件 C 补 C4；REVIEW.md 留痕 + 禁面扫描。
2. 三件套补齐后：`packages/plugins/file-write` / `param-guard` 转正；C1~C7 复核。
3. 切片⑤：manifest 规范回填复核（trust/R3 注记已补）、Phase 3 report、基准复采。
4. 切阶段收口 tag 归所有者；本轮代码未提交（工作区改动待所有者决定）。

## 关键提醒（坑/规范/易错点）

- **投影不是镜像**：事件追加字段必须同时改写入、投影（`project()`）、过滤点；[P-015](pitfalls/P-015-事件写了字段不等于投影读得到.md) 就是 receipt 写进账本但投影没搬，补偿静默跳过。
- **宿主装配时序**：serve 先于 alloc，两者先于任何通道请求 → [P-002](pitfalls/P-002-集成测试装配接线四类错.md)；`kill()` 与 `drainAndReap()` 不同 → [P-010](pitfalls/P-010-旧原语加新语义让调用点前提消失.md)；真子进程用显式栅栏 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)。
- **红测先行 / 绿色验真** → [P-007](pitfalls/P-007-绿色要当场验真.md)；跨边界序列化静默丢东西 → [P-009](pitfalls/P-009-跨边界序列化会静默丢东西.md)；中文文案 ASCII 双引号 → [P-011](pitfalls/P-011-中文文案里的ASCII双引号截断字符串.md)；自研 Schema 的动态键映射是静默漏检 → [P-014](pitfalls/P-014-自研Schema子集把动态键映射当成已支持.md)。
- 文档红线：ADR 只增不改（日期注记可）；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 非技术且新在前；handoff 滚动 5 份。
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-015）；方法索引：[skills/](skills/README.md)（S-001）。
