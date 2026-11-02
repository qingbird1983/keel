# 工作上下文交接卡

> 模板文件：每轮会话收尾**整体重写**本卡（覆盖式，不追加），≤ 150 行（规范见 `.agents/README.md`）。

- 更新：2026-11-03（会话主题：Phase 2 切片①施工——运行期注册通道 + 承接层骨架 + A 档合成样本验收）

## 当前阶段与状态（对照 roadmap 看板）

- **Phase 1 ✅ 完成**（tag `phase-1.end` = a8b8444）：A1~A8 逐条实测，一票否决五项全过，证据在 `docs/design/phase-1/report.md`
- **Phase 2 🔄 进行中**（tag `phase-2.start`）：**切片① ✅ 完成**（设计稿定稿 + ADR-0010 + 施工 + 验收，未单独打 tag）；B1 三条主张在真实多进程下核对通过，B5 只完成"合成组这一半"。**下一步 = 切片② 设计稿**（声明合成与权限收敛），定稿前不写本片实现代码（铁律 1）
- 关键文件：合同 `docs/roadmap/phase-2-cordis-compat.md`（§7 六片切分）；边界 `docs/design/phase-2/01-cordis-migration-boundary.md`（15 条 A/B/C/D + D 档零例外）；本片口径 `docs/design/phase-2/02-adapter-skeleton.md`（定稿 + 三处实现期细化）；`ADR-0010`（运行期注册通道）、`ADR-0009`（异步释放必须 await）
- 远端：`origin = github.com:qingbird1983/keel`（私有，SSH）；署名 = `qingbird1983`（ADR-0007）；CI 双 Node 矩阵（22 / 26）
- 门禁现状：六道全绿（`pnpm clean` 起）；**284 测试 / 36 文件**；零运行时三方依赖；最大实现文件 `core/src/scheduler.ts` 569 行（红线 600）；check-size 0 项提醒

## 上一轮完成了什么

- **两个新 op 落地**：`tool.register` / `tool.remove` 走 Cell→Core 通道，**先裁决后写状态**（拒绝 = `AUTH/DENIED` 落账且两半都不写）、版本号由内核指派、handler 与 schema 实体永不出舱；`@keel/core` 零改动
- **承接层成 6 个文件**：承接面清单与 `CORDIS_SURFACE`（未映射一律 `ADAPTER/UNSUPPORTED` 并给改法）、宿主端口与 Cell 端口同一异步签名、两半提交 + 失败回滚、三种旧入口形状归一化、旧插件专用 Cell 进程入口；宿主 per-spawn 换 `cellEntry`，bootstrap 形状不变
- **验收材料齐**：A 档合成样本 9 枚（5 常规 + 4 最坏写法探针）+ 反例 1 枚 + 共享 rig + 四份测试（tier-a 9 项 / registration-channel 5 项 / symbol-scan 4 项 / permission-rules 6 项）；"一行没改"由机械扫描强制
- **A1 调用面统一到异步**（3 处 `await`，主张不变）后复跑 3 次逐项一致：`sessions=20 cells=20 rounds=5 events=708` 恒定 → B8 不退化这一半成立
- **三条施工期新事实回写设计稿**（§5.2 / §7 / §12，只追加不放宽）：契约无"激活就绪"信号（本片用既有信号设屏障）；`toolCallTimeoutMs` 拦不住同步忙等（能落 timeout 的只有异步挂起）；scope 分区不按 run 归零（跨 run 断言要精确到 `name@version`）
- 两件保护证据的改动：样本目录进 `.prettierignore`（否则某次全库格式化会静默改写"一行没改"的材料）；跨舱不可见断言改精确匹配（`summary` 字段含 `sum` 会误命中）
- 收尾：H-019 归档（裁 H-014）、P-006 新增、看板 Phase 2 行与 CHANGELOG 0.1.027 更新

## 下一步（按优先级，注明阻塞项）

1. **切片② 设计稿**（合同 §7）：无报关单插件的声明合成、权限收敛路径；**必须收口本片登记的"装配就绪 → 才起 run"时机**（02 稿 §12 第 5 条），并把 `tool.provide` 的 `allow` 收窄从合成路径正式接上。定稿前先核对是否需要新的 ADR（声明合成规则若改变装配语义就要留痕）
2. 切片② 定稿后才能施工（铁律 1）；施工顺序写进稿内清单，新链路一律先写红色断言（铁律 7）
3. 规范修订两处仍待办（Phase 1 报告 §8）：standards/07 验收节补"交付物表逐条核对"强制项；`tests/` 根级类型检查（本轮集成测试文件多，价值上升）
4. 工具链小项（非阻塞）：CI 的 `actions/checkout@v4` 等仍以 Node 20 为目标、`ubuntu-latest` 已迁 Ubuntu 26——下次动 CI 时一并升版本并固定 runner 标签
5. 真实存量插件样本到位时：B1/B5 第二批复跑 + 边界表符号回填（不阻塞施工，阻塞"真实插件可迁移"表述）——**样本目录已排除统一格式化，真样本可直接原样落盘**

> backlog（条件未触发，勿顺手做）：probe 通道、builtin 补偿动作、退避参数可配置面、migration 多步链、未决污染清单 CLI、Cell 池化、容器后端、分布式、观测生态与跨 run 读取（Phase 3）。

## 未决问题

- 仓库是否转公开（所有者择时；MIT + 署名已就绪）
- `throughSeq` 载荷细节在切片⑤设计稿定案（方向已由 ADR-0008 锁定）
- Node 26 是否升为 `engines` 下限（当前 `>=22`；CI 矩阵已双覆盖，先观察）
- "激活就绪"该由谁提供：Cell 主动通知（新帧类）还是宿主经装配编排查询（切片② 抉择，倾向后者的原因是少一处协议面）

## 关键提醒（坑/规范变更/易错点，链接 pitfalls 编号）

- **Phase 2 铁律**：D 档零例外已定——任何"为了先跑起来"的兼容口子都属返工；映射不到就拒绝并留痕，替代写法进迁移手册
- **承接层姿态**（02 稿 §3）：未映射旧面**抛错给改法**，绝不返回 undefined/空表；`ADAPTER/*` 只表示"旧面映射缺失"，运行期裁决失败原样抛 Core 码，归因指向内核
- **证据表述纪律**：合成组结果不得表述为"真实存量插件已验证"；F4（舱内原生 `fetch`/`fs` 不被拦截）与"`toolCallTimeoutMs` 拦不住同步 handler"共同约束 B1/B2 措辞；两批材料在报告分开列
- **真实子进程测试要先立时序假设**：轮次是瞬时的、舱起飞要上百 ms——屏障用既有可观测信号，放弃等待的条件写成证据 → [P-006](pitfalls/P-006-真实子进程测试的时序屏障.md)
- **"测试全过"不等于门禁过**：看 vitest 的 `Errors` 行与真实退出码；Promise 型资源释放必须 await → [P-005](pitfalls/P-005-浮空close与Node版本差掩盖硬缺陷.md)
- **类型检查不得依赖构建产物**：新包 import workspace 兄弟包就要补它的 `tsconfig.json`（noEmit 那份）`paths`；**每轮收尾至少一次"`pnpm clean` 后跑全链"** → [P-004](pitfalls/P-004-类型检查依赖构建产物.md)
- **跨包 import 运行期走 dist**：改 `packages/*/src` 不 rebuild 就跑 `tests/` → `x is not a function` → [P-002 规则 4](pitfalls/P-002-集成测试装配接线四类错.md)
- **集成测试装配接线四类错**（deps/opts 参数位、模块顶层捕获未初始化、依赖材料先于组件构造、dist 解析）→ [P-002](pitfalls/P-002-集成测试装配接线四类错.md)
- **CLI 资源收束覆盖所有 spawn 源** + **冷 Ledger 实例按 runId 拒接笔** → [P-003](pitfalls/P-003-CLI收束与实例接笔两类错.md)
- **Windows 子进程 exit 滞后 stdout 关闭**——死亡第一信号 = 通道关闭 → [P-001](pitfalls/P-001-windows子进程事件序.md)
- **阶段验收执行法**（抽象主张 → 可断言口径；交付物表横向核对；证据行入报告）→ [S-001](skills/S-001-阶段验收执行法.md)
- 调度器是轮内事件唯一编排者但**非唯一写入者**：`AUTH_DENIED`/`EFFECT_*`/`STATE_SNAPSHOT_REF` 由组件直写，seq 连续但不入 `basedOn`
- 门禁链取真实退出码：`... | tail` 会把失败吞成 exit 0（用 `> log 2>&1; echo EXIT=$?`）；本地绿灯 ≠ CI 绿灯
- 文档红线：ADR 只增不改；docs/ 新增必须登记 `docs/README.md`；报告/handoff 不写本机绝对路径；CHANGELOG 面向非技术读者且"新在前"
- cell 侧不持有 scope/runId（宿主盖章）；seq 是 Run 内单调；恢复/延续一律新 runId；typescript 锁 ^5.9 / ES2022（无 Promise.withResolvers）
- 工具变更传播口径：运行期注册**下一轮**才进决策输入（`consumeSchemaChanges` 在轮边界取走）；`discover` 稳定排序 → 缓存键不受注册顺序影响；分区是 **scope 级**，跨 run 不归零
- 踩坑索引：[pitfalls/](pitfalls/)（P-001~P-006）；方法索引：[skills/](skills/README.md)（S-001）
