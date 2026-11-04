# 插件 `engine-react` 评审留痕（Phase 4 切片④，03 稿 §8 自检）

> 口径：机器层（禁面扫描）每次门禁都跑；本文件是人工层的一次性留痕。引反面教材只写行号不抄判据串。

## 1. manifest 摘录（能力 / 资源 / 声明三项）

- **能力**：只声明 `model.adapter` 一项——engine 唯一被允许的能力；`resources` 为空对象（无工具超时这个量）。
- **声明**：`engine.loop:"react"`、`engine.model.{ref,name}`（profile 内模型插件 id + 模型名）、`engine.tools`（允许请求的工具名，装配期逐个复核提供者）、`engine.maxSteps`。
- **补偿 / hooks / subscriptions / governance**：全部为空——engine 不产生副作用、不自审、不发布扩展点。

## 2. 对 01 清单逐条（不适用 + 一句理由）

| 行  | 判定   | 理由                                                                        |
| --- | ------ | --------------------------------------------------------------------------- |
| A1  | 不适用 | 无提示词面；本模块只把 Core 投影好的消息转成模型请求                        |
| A2  | 不适用 | 不宣告轮次结束；终结是返回 `{decision:{kind:"done"}}`，由 Core 裁决并写账本 |
| A3  | 不适用 | 不读不算任何计量量（机器扫描零命中）                                        |
| A4  | 不适用 | 返回形状封闭（E3）；不夹带下一条指令                                        |
| B1  | 不适用 | 无运行期提权动作；模型调用授权在 Core 网关                                  |
| B2  | 不适用 | 身份由宿主通道盖章；代码不持有会话标识                                      |
| B3  | 不适用 | 零服务定位：唯一宿主接触面 = `ctx.client.modelInvoke`（网关）               |
| B4  | 不适用 | package.json 零依赖；源码零 import                                          |
| B5  | 不适用 | 无可调度量；一步时限由宿主按契约 300s 档强制                                |
| C1  | 不适用 | 无扩展点发布/取用                                                           |
| C2  | 不适用 | 无事件总线用法                                                              |
| C3  | 不适用 | 无权威状态：每步入参由 Core 投影给出，快照只是 pid 证据                     |
| C4  | 不适用 | 行为唯一事实源 = 本目录 manifest + dist 构建产物                            |
| D1  | 不适用 | 入口 = Keel 原生形状（`export function step`），不依赖外部框架              |
| D3  | 不适用 | 单进程 Cell 承载全部功能，无浏览器半                                        |
| E1  | 不适用 | 禁直连出网（机器扫描零命中）；模型调用走网关                                |
| E2  | 不适用 | 禁读进程环境（机器扫描零命中）；密钥不在 engine 侧                          |
| E3  | 不适用 | 无账本 / 效果 / 工作区 / 工具注册入口（机器扫描零命中）                     |
| E4  | 不适用 | 不注册策略钩子（被审者不能自审）                                            |
| E5  | 不适用 | 源码零密钥形态字面量                                                        |

## 3. 看代码三件事

- **入口形状**：`src/index.ts` 导出 `step(input, ctx)` 与只读 `snapshot()`；宿主入口 `cell-runtime/src/main.ts` 在 `markReady()` 前登记 `engine.step`。
- **一步做什么**：消息/工具清单 → 模型协议形状 → `client.modelInvoke` → 归一工具调用 → 返回 `{decision, message}`。没有工具执行、没有账本写入。
- **import 清单**：零（类型为本地结构别名，与三件套同口径）。

## 4. 门禁与真进程用例证据（2026-11-04）

- 真进程 e2e（`tests/engine-kind-e2e.test.ts`，D3/D5/D2/协议封闭/D4）：9 例全绿。
- CLI 冒烟（`apps/keel/test/cli.test.ts` 新增一例）：`keel run --profile tests/fixtures/profile/react-loop/profile.yaml` 经引擎驱动收束。
- 禁面扫描：`native-plugin-scan: clean`（本目录零命中）。
- 包内单测（`test/engine-react.test.ts`）：工具意图 / 终结 / OpenAI 形状归一 / 缺声明与超步数拒绝。

## 5. 不可观察面（登记）

- 模型 provider 的真实响应形状不在本插件内验证（mock 承载 CI；真适配器手动验证，不进 CI）。
- `engine.step` 的 300s 一步时限由宿主强制，插件侧不可观察。
