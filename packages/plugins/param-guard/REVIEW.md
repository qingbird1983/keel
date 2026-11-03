# 插件 C `param-guard` 评审留痕（02 稿 §5 模板；转正记录 2026-11-04，切片④）

> 口径：机器层（禁面扫描）每次门禁都跑；本文件是人工层的一次性留痕。引反面教材只写行号不抄判据串（02 稿 §7 措辞纪律）。

## ① manifest 摘录（能力 / 资源 / 补偿三项）

- **能力**：无（`permissions: []`——policy 分支 schema 强制为空；策略只有否决权，无任何能力申请）。
- **资源**：`{}`（policy 分支 schema 强制为空；策略舱无 `toolCallTimeoutMs`，唯一预算 = 宿主侧 hook 请求超时 + HookBus 超时，ADR-0012）。
- **补偿**：`templates: []`（强制为空）——合法：策略零副作用，无可补偿物。

## ② 01 清单 18 行逐条（不适用 + 一句理由）

| 行  | 判定   | 理由                                                                              |
| --- | ------ | --------------------------------------------------------------------------------- |
| A1  | 不适用 | 无提示词面——策略只对入参做布尔判断并回裁决                                        |
| A2  | 不适用 | 裁决对象是"是否放行"，轮次收束始终由内核写（B7① 口径）                            |
| A3  | 不适用 | 不读不算任何预算量（机器扫描零命中）                                              |
| A4  | 不适用 | 输出 = 封闭键集裁决 `{verdict, reason}`，无法夹带指令（禁区校验在内核 HookBus）   |
| B1  | 不适用 | 策略**就是**审批链的一环（hook①），自身不再申请任何权限                           |
| B2  | 不适用 | 入参只有 `{tool, paramsDigest}`（契约既有形状），不含任何会话标识                 |
| B3  | 不适用 | 零服务定位：模块零 import，无任何宿主依赖注入                                     |
| B4  | 不适用 | package.json 零依赖字段；import 清单 = 空（B4-deps/B4-import 机械判定双零）       |
| B5  | 不适用 | 无工具体；hook 时限在宿主侧，策略代码不含任何时限量                               |
| C1  | 不适用 | 唯一注册面 = `export const hooks`（键集与报关单完全相等，两向强制），无扩展点     |
| C2  | 不适用 | 无事件总线用法                                                                    |
| C3  | 不适用 | 无共享状态：模块级只有规则常量与纯函数                                            |
| C4  | 不适用 | 行为唯一事实源 = 本目录 manifest + dist 构建产物，无外部组合层                    |
| D1  | 不适用 | 入口 = Keel 原生策略形状（policy-main 装载 `hooks` 表），不依赖外部框架世代       |
| D2  | 不适用 | 无工具体；hook 键集由 `normalizePolicyHooks` 与报关单逐名核对（缺/多/非函数均拒） |
| D3  | 不适用 | 独立策略进程承载全部功能，无浏览器半                                              |
| D4  | 不适用 | 非观察插件；验收 = 真进程账本归因（C-E1~E4），无自评拆问面                        |
| D5  | 见 ⑤   | 不可观察面登记如下                                                                |

## ③ 看代码三件事

- **入口形状**：`src/index.ts` 仅 `export const hooks = { toolApproval: fn }`（单键）；宿主经 `wirePolicies` 起独立策略舱 → 探就绪 → 注册到 HookBus（ADR-0012：全部就绪后才注册，两策略争同一 hook = 整份拒绝）。
- **工具体字段**：无工具（policy 分支禁止）；handler 形状 = `(input) => verdict`，入参 `{tool, paramsDigest}`（`paramsDigest` 在 toolApproval 通道承载明文 params——契约既有形状，08 稿 F3 注记），出参封闭键集 `{verdict:"approve"|"deny", reason?}`。
- **import 清单**：零。裁决键集/值域校验都在内核 HookBus（把校验挪进舱内 = 让被审者自审，ADR-0012 决策 2）。

## ④ 门禁与真进程用例退出码证据（2026-11-04）

- 真进程 e2e（`tests/native-param-guard-e2e.test.ts`，C-E1~E4，联装 = 插件 B 工具舱 + 本策略舱）：**红测先行证据**——策略件缺席时 e2e 红（`Test Files 1 failed`），就位后 4/4 绿（vitest 退出码 0）。C-E1 危险参数（content 含 `TOPSECRET`，装配 allow / governance guard 结构上看不到的面）被 deny，介入 seq 进 `DECISION.basedOn`，handler 零执行；C-E2 正常参数放行不误伤；C-E3 kill 策略舱 → `HOOK_VERDICT{fallback:true}`、run 照常推进不崩（B7① 口径延续）；C-E4 未申领 hook 零介入 + `ASSEMBLY_RECORDED.policies` 记账正确。
- 禁面扫描：`native-plugin-scan: clean`（退出码 0）。
- 包内单测（`test/param-guard.test.ts`，4 例）随主线 vitest 全绿。

## ⑤ 不可观察面（D5 行登记）与人工补声明记录

- **不可观察面**：拦截规则常量（`TOPSECRET` 子串）硬编码在策略代码内——policy 分支 schema 无规则声明位（08 稿 F2），规则变更 = 代码评审 + 重发布，不临场改；hook 入参之外的会话态策略舱一概不可见（ADR-0012：除入参它什么都看不见）。
- 人工补声明：无（报关单声明面 = `hooks:["toolApproval"]`，schema 已强制其余节为空）。
