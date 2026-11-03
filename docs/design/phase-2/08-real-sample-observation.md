# Phase 2 真样本观察记录：三枚真实 Cordis 插件打在兼容层的哪一层

- 状态：**观察记录**（2026-11-03；不是设计稿、不是定稿——**本稿不改动 [01 稿边界表](01-cordis-migration-boundary.md) 的任何档位**，只做登记与呈报，待所有者定档后才回填 01 稿）
- 日期：2026-11-03
- 材料性质：**真实第三方发布物**（不是合成样本）。取回方式、commit、许可证与"源码不入库"的理由见 [real-samples/SOURCES.md](../../../tests/fixtures/cordis-plugins/real-samples/SOURCES.md)
- 关联：[phase-2 合同](../../roadmap/phase-2-cordis-compat.md) §5 B5、§7 切片⑥；[01 稿 边界表](01-cordis-migration-boundary.md)；[02 稿](02-adapter-skeleton.md) §3 姿态 1 与 §7 判据；[03 稿](03-manifest-synthesis.md) §4/§10；[05 手册](05-migration-handbook.md)

## 1. 这份文档回答什么

合同 B5 的原话是"真样本复跑 + 符号回填"。本轮所有者给了三条挑选标准（**轻量 / 无复杂原生依赖 / 覆盖只读与有副作用**）和一个问题：**兼容层在这些真实插件上，遇到了哪些合成样本里没见过的坑？边界表要不要补？**

结论先说：**要补，而且缺口不在"ctx 上还有哪个成员没归类"这一层**。三枚真样本没有一枚走到 ctx 面——它们分别死在**入口形状识别**（2 枚）和**宿主包解析**（1 枚）上，而这两层是边界表 15 行都没有覆盖的前置门槛。同时 `keel observe` 把这三枚"装载失败"报成了"观察成功、候选可用"（§5 缺陷 D1/D2/D3），这条比缺行更要紧：它让 B5 的证据在机器口径上是假的。

## 2. 跑的是什么

| 包（版本）                          | 作用                                                | 类型             | 入口           | 运行时三方依赖                      |
| ----------------------------------- | --------------------------------------------------- | ---------------- | -------------- | ----------------------------------- |
| `dsh-plugin-local-life` @ 0.3.2     | 本地生活算术（预算/分账/单价/折扣/换算/清单/摊还…） | 只读计算         | `lib/index.js` | 0（按 npm 名 import 宿主包）        |
| `dsh-scrape-webpage` @ 1.0.0        | 抓网页正文 + 关键词统计 + 下载内容图片 + 识图扩展点 | 有副作用         | `lib/index.js` | 0（经宿主 shell 服务起 `curl.exe`） |
| `@99galaxy/dsh-turn-notify` @ 1.0.2 | 本轮结束时发 Windows 通知（主体在**浏览器半**）     | 有副作用（通知） | `lib/index.js` | 0                                   |

命令（每枚一份 `--out`，原因见 §5 缺陷 D1）：

```bash
node apps/keel/dist/main.js observe \
  --plugin tests/fixtures/cordis-plugins/real-samples/<pkg>/lib/index.js \
  --out  tests/fixtures/cordis-plugins/real-samples/observed/<pkg>
```

产物：`observed/<pkg>/legacy-index.candidate.json`、`.gaps.md`、`observe.txt`、两趟账本。**三份 gaps.md 与三份 candidate.json 的 md5 逐字节相同**（账本去掉时间戳后也逐条相同）。

## 3. 观察结果：三枚全部死在走到 ctx 之前

| 包               | `keel observe` 报了什么                               | 真实根因（我们单独起舱收 stderr 才拿到）                                                                        |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `local-life`     | `state=failed events=9 names=[]` → `ACCEPT`、退出码 0 | 舱进程 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`                                   |
| `scrape-webpage` | 同上（一模一样）                                      | `[ADAPTER/ENTRY-UNKNOWN] … expected module.exports=fn(ctx), {activate(ctx)} or ESM default fn(ctx); got object` |
| `turn-notify`    | 同上（一模一样）                                      | 同上 `ADAPTER/ENTRY-UNKNOWN`                                                                                    |

三枚的账本都是同样 9 条事件，终态 `RUN_FAILED{reasonCode:"CELL/CRASH", reason:"cell channel closed (crash per killRequested; exit event pending)"}`——**根因不在账本里**（§5 缺陷 D3）。

入口形状这条不是我们的推断。`@deepseek-ai/cordis@4.0.5` 的 `src/registry.ts` 白纸黑字定义三种插件形态：`Function (ctx, config)` / `Constructor (ctx, config)` / `Object { apply(ctx, config) }`，**其中没有 `activate`**；发布物普遍走第三种（`export const name` + `export const inject` + `export function apply(ctx, config)`，local-life 另有 `export const Config = z.object({...})` 做配置校验）。也就是说：承接层 `normalizeLegacyModule` 认的三种形状里，**两种（`module.exports=fn(ctx)`、`{activate(ctx)}`）在当前 Cordis 世代不是主流或已不存在**，而主流形状我们不接受。`ADAPTER/ENTRY-UNKNOWN` 的文案因此还把迁移方向指错给了历史形状。

顺带一条正面证据：本轮 pass-1 账本里 `DECISION` 带 `"throughSeq": 3`——切片⑤ 落的归因字段在真实第三方插件的装载趟里就写出来了。

## 4. 真样本暴露的旧形状面（探针实测 + 一手来源核对）

两个只读探针（未入库，见 SOURCES.md §5）：`probe.mjs` 用记录代理喂 `apply(ctx, config)`，录触点；`probe2.mjs` 用**真实承接层 ctx**喂同一个 `apply`，看未映射面露出什么形状。

| 面                                                                                                                                                                                                      | 出现在哪                                                                                              | 01 稿里有没有归属                                                                                 | 一手来源                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `export const inject = ['timer','tools','systemPrompt']`                                                                                                                                                | scrape / local-life                                                                                   | **无**（#12 讲的是"依赖别的插件的顺序"，不是依赖声明）                                            | cordis `src/registry.ts`                                              |
| `ctx.provide(id, impl)` / `ctx.get(id)`                                                                                                                                                                 | scrape（`scrape.imageAnalyzer` 注册表；`web`/`shell`/`sandboxPolicy`/`sessions`/`approval` 服务自取） | **无**（#8 只写 `ctx.state`/share，#15 只写 bus）                                                 | cordis `src/service.ts`、`src/context.ts`                             |
| `ctx.inject(deps, cb)` + `scope.effect(() => dispose)`                                                                                                                                                  | turn-notify                                                                                           | **无**                                                                                            | cordis `src/context.ts`                                               |
| `ctx.systemPrompt.section(...)`                                                                                                                                                                         | local-life / scrape（**两枚**）                                                                       | **无**                                                                                            | `@deepseek-ai/dsh-system-prompt`（peerDependencies）                  |
| `ctx.logger.info(fmt, …)`                                                                                                                                                                               | turn-notify                                                                                           | #11 说的是"自印 console 日志"，logger 是它的正式版本                                              | cordis `src/logger.ts`                                                |
| 工具定义体 `{name, description, parameters, output:{schema,render}, timeoutMs?, isConcurrencySafe?, execute(args, exec)}`                                                                               | local-life / scrape（经 `defineTool`）                                                                | **#1 行只写 `(name, schema, handler)`**——字段名全不同：`schema`→`parameters`、`handler`→`execute` | `@deepseek-ai/dsh-tools` `lib/types/schema.d.ts`（DefineToolOptions） |
| `exec` 第二参数 `callId/rootCallId/arguments/agent/signal/token`                                                                                                                                        | scrape                                                                                                | **无**（`scope` 在 withheld 桶，`exec` 这条通道我们没有）                                         | dsh-tools `lib/types/index.d.ts`（ToolExecutionInput）                |
| `exec.deferContext(UserMessage)` / `exec.concludeTurn()`                                                                                                                                                | 框架提供（三枚未用）                                                                                  | **无**                                                                                            | dsh-tools `lib/types/index.d.ts`（ToolRunContext）                    |
| 运行中沙箱升级 + 人工审批：`sandbox_permissions:"danger-full-access"`（**模型参数**）+ justification → `approvalSvc.request({agent,toolName,callId,reason,signal})` → `allowed-once/rejected/cancelled` | scrape `lib/fetch.js` L108–142                                                                        | **无**（#7 讲的是插件自算预算/停止，不含"向用户要更宽权限"）                                      | 样本一手；审批服务来自宿主 `ctx.get('approval')`                      |
| 外部组合层 `package.json > dsh.bundle.patch` → `cordis.patch.yml` 的 `insert` 行（含 config 值）                                                                                                        | **三枚全有**                                                                                          | **无**（"补一张报关单"假设声明在代码里）                                                          | 三枚仓库各一份                                                        |
| 浏览器半 `dsh.client.platform="web"` + `lib/client.js`（`ctx.config` / `ctx.sessions.list` / `ctx.uiSession.*`）                                                                                        | turn-notify                                                                                           | **无**（整条轴都不在表上）                                                                        | 该包 package.json `exports` 与 `dsh.client`                           |

对照下来有个反直觉的事实：**01 稿里我们花最多力气的几条，真样本一条都没命中**——`ctx.llm`（自带 SDK 调模型）、`ctx.share`、`ctx.bus`、`ctx.effects.reclaim`、`ctx.hooks` 在三枚源码里出现 0 次。命中的是 #1（但字段名不同）、#4/#11/#12（边缘形态）和 #5（网络经宿主 shell，不是插件自己 fetch）。也就是说边界表是按"我们假设的旧写法分布"建的，真实分布集中在表外的另一些面上。

**探针 2 的落点比预期更糟**（这条与真样本无关，是我们的实现形状）：把 `apply` 喂给真实承接层 ctx，scrape 在第一个面就 `TypeError: ctx.provide is not a function`；`ctx.provide/get/inject/effect/systemPrompt/logger/sessions/uiSession` **全是 `undefined`** → 裸 TypeError，没有 `ADAPTER/UNSUPPORTED` 的改法去处（切片⑤ 只把 `llm.*` 未知成员兜住了，见 core.ts `llmSurface()`）。turn-notify 更极端：它写 `if (!ctx \|\| typeof ctx.inject !== "function") return;`——喂真实 ctx 时**不抛错、不注册、安静返回**。防御性好的旧插件在 Keel 上的表现是"跑通了但什么都没干"，比崩掉更难发现。

## 5. `keel observe` / 承接层的缺陷（D 编号，与边界档位无关）

| 编号 | 现象                                                                                                                                                               | 证据                                                                                                              | 修法方向（**本轮不改代码**，切片⑥ 定稿后动）                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D1   | 候选名由 `path.basename` 合成 → 三枚入口都叫 `index.js`，产物**同名互相覆盖**；manifest `name` 也错了（`legacy-index` 而不是包名）                                 | 三份 gaps.md/candidate.json md5 相同；SOURCES.md §4 的 `--out` 是被迫的规避                                       | 优先读同目录 `package.json > name`，退化才用文件名；产物名带包目录                                               |
| D2   | **观察失败被报成观察成功**：舱崩、零工具、零 cap → 空候选仍过五步校验 → `validate: ACCEPT` + **退出码 0**                                                          | 三枚全部如此；`cmd-observe.ts` 的退出码 = 五步校验是否通过                                                        | 把"装载是否成功 / 是否观察到任何面"并进退出码与结论口径；空候选必须**非零**                                      |
| D3   | **舱的 stderr 有管道但无人读**：根因既不入账本也不打印，`RUN_FAILED` 恒为通用 `CELL/CRASH`                                                                         | `isolation.ts` 交 `stderr`，`packages/host` 与 `apps/keel` 里 `grep stderr` 命中 0 次；三枚账本去时间戳后逐条相同 | 宿主侧把 stderr 收进诊断缓冲，`RUN_FAILED{CELL/CRASH}` 附最后 N 行摘要（注意 P-009：跨边界要显式带，不会自动到） |
| D4   | 旧 ctx 的未映射**顶层命名空间** = `undefined` → 裸 TypeError，无改法去处；旧代码的类型守卫还会把它变成静默 no-op                                                   | 探针 2 两条输出                                                                                                   | 顶层也上 Proxy 护栏（切片⑤ `llmSurface()` 的推广）；护栏清单来自 §4 的面 census                                  |
| D5   | 观察**只读代码不读声明层**：config 值来自 `cordis.patch.yml`，因此 `config.personaSection` 条件分支观察不到（local-life 的 `systemPrompt.section` 探针里就不出现） | 传 `config={}` 时该面 0 触点；patch 行写着 `personaSection: true`                                                 | 观察输入面要能注入外部 config；否则候选下界系统性偏低（03 稿 §4 的"下界"要加这条限制）                           |

D2 是最需要立刻处置的：它不是"少个信息"，而是**B5 的机器口径当前给假阳性**。合同 §6 风险 5 说的"合成产物冒充证据"是同一族的漂移形态。

## 6. 边界表补充建议（**档位待所有者定，本稿不自改判**）

建议新增候选行（编号续 #15；"倾向"栏是我给的理由方向，不是判定）：

| 候选 #  | 旧写法                                                                                    | Keel 侧最近的对应物（若有）                       | 倾向与待决点                                                                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **#16** | 入口形状 `export const name/inject/Config` + `export function apply(ctx, config)`         | 承接层装载（`normalizeLegacyModule`）             | 门槛在**装载层不在 ctx 层**：可作 A 档（适配层补形状、代码不改）。待决：`ENTRY-UNKNOWN` 文案与 05 手册都要按 v4 重写                                                                                                                                   |
| **#17** | 按 npm 名 import 宿主包（`@deepseek-ai/cordis`/`schemastery`/`dsh-tools`）                | 无（Cell 装载只 import 插件本体）                 | 待决：**Keel 是否供给这些包**。供给 = 把他方代码放进我们的供应链（安全红线 4 的事），不供给 = 这类插件装载不了                                                                                                                                         |
| **#18** | `export const inject = [...]` 依赖声明                                                    | manifest 的 `requires` / 装载门（ADR-0011）       | 倾向 B 档（补声明即可，且**代码里已经写了**——是声明合成的现成来源）。待决：与 `ctx.inject()` 撞名，登记时要区分                                                                                                                                        |
| **#19** | `ctx.provide(id, impl)` / `ctx.get(id)` 服务定位与扩展点                                  | #8 share / #15 bus 同族但载体不同                 | 倾向 D 档（跨插件写通道不存在）。待决：`ctx.get('shell')` 这类**宿主服务**与"别的插件提供的扩展点"要不要拆两行                                                                                                                                         |
| **#20** | `ctx.systemPrompt.section(...)` 提示词贡献                                                | 无（决策输入由内核组装）                          | 倾向 D 档（改决策输入 = I1/V6）。待决：若给 B 档路径（`promptSections` 声明 + 装配期注入 + 账本留痕）是否破坏"插件不接管决策输入"这条立场                                                                                                              |
| **#21** | `ctx.effect(factory)` / `scope.effect(() => dispose)`                                     | Cell 进程边界（进程亡即资源亡）                   | 倾向 A 档说明。待决：登记点是否进装配审计                                                                                                                                                                                                              |
| **#22** | 工具定义体 `parameters/execute/output.render/timeoutMs/isConcurrencySafe`                 | **#1 行的实现期细化**                             | 待决两条：(a) 只补 #16 不补字段名 → 注册出"有名字、无 schema、无处理器"的工具 = **静默降级**（姿态 1 禁止），缺字段必须拒；(b) `timeoutMs`/`isConcurrencySafe` 是代码里就有的声明，声明合成应读它们（现在只有 `TOOL_CALL_TIMEOUT_UNKNOWN` 人工待审项） |
| **#23** | `exec` 第二参数（`callId`/`agent`/`arguments`/`signal`）                                  | 内核通道已盖章的身份（Cell 不可见）               | 待决：哪些字段可以给。`signal`（取消是内核语义）倾向给；`exec.agent` 倾向不给——它就是"按会话身份做全局操作"的入口                                                                                                                                      |
| **#24** | `exec.deferContext(msg)` / `exec.concludeTurn()`                                          | 无（策略 hook 只有四个白名单点，ADR-0012）        | 倾向 D 档，且是本轮找到的**最强接管形态**（工具宣告"本轮到此结束"）。样本未用，框架一手来源确认存在                                                                                                                                                    |
| **#25** | 运行中权限升级 + 人工审批（`sandbox_permissions` 由模型参数给 + `approvalSvc.request()`） | Authorizer（动作前、按 manifest 裁决）+ 策略 hook | 倾向 D 档：申请方 = 被授权方，与"没声明即不存在"相反。待决：替代写法（预声明宽词表 / 策略 hook）能否覆盖"抓 HTTPS 需要出沙箱"这个真实需求                                                                                                              |
| **#26** | 浏览器半 `dsh.client.platform="web"`（`ctx.uiSession.*` / `ctx.sessions.list`）           | 无（Keel 无前端承载体）                           | 倾向**档外**：这不是 ctx 映射问题，是"并非所有 dsh 包都是 Cell 形状插件"。turn-notify 的 node 半只是 Loader 注册行，功能全在浏览器半                                                                                                                   |

一句提醒：**#16/#17 不解决，上面所有行都轮不到执行**——真实插件现在连 ctx 都摸不到。这也是为什么本稿说缺口不在"再归类几个成员"。

## 7. 为什么合成样本没暴露这些（方法层）

1. **样本是我们按假设写的**：入口形状取的是我们认知里的旧形状（`module.exports=fn(ctx)` / `activate` / ESM default），工具字段取的是 `(name, schema, handler)`。用自己的假设校准自己的假设，档位判据必然偏窄。
2. **合成样本只演"插件代码"，不演"宿主组合层"**：`cordis.patch.yml` / `package.json > dsh.*` 这一层在真实发布物里承载 config、启用与否、客户端平台——我们从来不需要它，于是也从未发现"声明不在代码里"。
3. **合成样本没有装载期依赖**：我们的 fixture 是单文件 `.cjs`/`.mjs`；真实包按 npm 名 import 宿主包、有 `peerDependencies`。装载失败这一整类失败形态没进过门禁。
4. **`keel observe` 的验收只测"能合成出候选"，没测"装载失败时候选该长什么样"**——于是 D2 一直没被抓到（B2 测试通过 ≠ 观察结论可信）。

对应的纪律补法（进 05 手册与 standards/05 的建议，见 §8）：合成样本要标注"形状由我们定义"，真样本要保留原始包结构（`package.json` + 外部 YAML + 多文件模块），**并且档位判据的每次修订都记录"第几号真样本暴露的"**。

## 8. 下一步（不在本轮动）

> **2026-11-03 补记（[ADR-0014](../../adr/ADR-0014-drop-legacy-ecosystem-compat.md)）**：本节已被战略转向取代——切片⑥ 终止、边界表候选行 #16~#26 不回填、B5 作废；§8.1~§8.3 不再执行，D1~D5 与 12 个无归属面的价值转存 Phase 3 反面教材（[design/phase-3/01](../phase-3/01-legacy-anti-patterns.md)）。本稿其余内容作为观察记录留痕保留。

1. **切片⑥ 设计稿**：把 D1~D5 作为"观察工具的正确性"子项，把 #16~#26 作为边界表第二轮呈报所有者定档；定稿前不写实现代码（铁律 1）。
2. 所有者先给两个决定，后面的活才排得动：**(a) Keel 是否供给 `@deepseek-ai/*` 宿主包（#17）**；**(b) 提示词贡献面与工具终止宣告（#20/#24）走 D 档还是给声明路径**。
3. 真样本扩量：三枚是 n=3，且是"轻量 + 零原生依赖"筛出来的（所有者给的标准本身就排除了重型插件）。要支撑 B5 的"真实存量插件已验证"表述，至少还需要若干枚**声明在代码里、真的用 `ctx.llm`/`ctx.share`/`ctx.bus`** 的历史世代插件——否则会得出"这些旧写法现实中没人用"的错误结论。
4. 本轮已交付：三枚源码取回（登记见 SOURCES.md）、`observed/<pkg>/**` 证据、探针结论摘录。未做：任何代码修改、任何档位改判、任何候选转正。
