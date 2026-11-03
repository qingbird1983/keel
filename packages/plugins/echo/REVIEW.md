# 插件 A `echo` 评审留痕（02 稿 §5 模板；转正记录 2026-11-03，切片②）

> 口径：机器层（禁面扫描）每次门禁都跑；本文件是人工层的一次性留痕。引反面教材只写行号不抄判据串（02 稿 §7 措辞纪律）。

## ① manifest 摘录（能力 / 资源 / 补偿三项）

- **能力**：`[{ cap: "tool.provide", reason: "提供单个只读工具 echo，验证授权与工具发现" }]`——无 allow（缺省 `*`，工具清单在代码内）；无越界能力。
- **资源**：`toolCallTimeoutMs: 10000`（capability 必填，硬强制）。
- **补偿**：`templates: []`——合法：无越界能力即无补偿完备性要求（03 稿 F1）；echo 无副作用。

## ② 01 清单 18 行逐条（不适用 + 一句理由）

| 行  | 判定   | 理由                                                                                  |
| --- | ------ | ------------------------------------------------------------------------------------- |
| A1  | 不适用 | 无任何提示词面——工具只回显输入，不触模型输入组装                                      |
| A2  | 不适用 | handler 只返回结果对象，不触碰轮次控制                                                |
| A3  | 不适用 | 不读不算任何预算量（代码零出现相关词，机器扫描亦零命中）                              |
| A4  | 不适用 | 结果只含 `{echoed}`，不夹带指令                                                       |
| B1  | 不适用 | 权限面 = manifest 单项声明，运行期无任何申请动作                                      |
| B2  | 不适用 | 身份由宿主通道盖章；代码不持有任何会话标识（handler 不用 `ctx` 参数）                 |
| B3  | 不适用 | 零服务定位：模块零 import、handler 零宿主依赖                                         |
| B4  | 不适用 | package.json 零依赖字段（B4-deps 机械判定）；import 清单 = 空（B4-import 机械判定）   |
| B5  | 不适用 | 工具定义只有 name/schema/handler 三字段，无任何可调度量                               |
| C1  | 不适用 | 无扩展点发布/取用——单插件单工具，零插件间通道                                         |
| C2  | 不适用 | 无事件总线用法                                                                        |
| C3  | 不适用 | 无共享状态：模块级只有常量表，handler 无副作用                                        |
| C4  | 不适用 | 行为唯一事实源 = 本目录 manifest + dist 构建产物，无外部组合层                        |
| D1  | 不适用 | 入口 = Keel 原生形状（默认入口装载 `export const tools`），不依赖外部框架世代         |
| D2  | 不适用 | 工具体字段 = 契约 CellTool 形状（name/schema/handler），五步校验 + 装载期发布双重核验 |
| D3  | 不适用 | 单进程 Cell 承载全部功能，无浏览器半                                                  |
| D4  | 不适用 | 非观察工具；本切片验收 = 账本事件存在性检查（E1~E6），无自评拆问面                    |
| D5  | 见 ⑤   | 不可观察面登记如下                                                                    |

## ③ 看代码三件事

- **入口形状**：`src/index.ts` 仅 `export const tools`（单元素）；宿主入口（cell-runtime `main.ts`）装载 → 本地登记 → 跨进程发布（tool.register）→ markReady（03 稿 §4）。
- **工具体字段**：`name: "echo"` + JSON Schema（object / text 必填 / additionalProperties false）+ handler `(params) => ({ echoed: params.text })`——三字段齐全，无缺字段默认值兜底。
- **import 清单**：零（F5；B4-import/B4-deps 机械判定双零）。无 snapshot / compensations / migrate 导出 = 无状态 Cell。

## ④ 门禁与真进程用例退出码证据（2026-11-03）

- 六道门禁：build=0 / typecheck=0 / lint=0 / format:check=0 / **test=0（43 文件 344 测试全绿）** / check-size=0（0 提醒）。
- 禁面扫描（`node scripts/scan-native-plugins.mjs`）：`native-plugin-scan: clean`（退出码 0）。
- 真进程 e2e（`tests/native-echo-e2e.test.ts`，5 用例）：**红测先行证据**——main.ts 补丁前 E1 发现面断言红（决策输入三轮全盲 `[[],[],[]]`）+ E4 红（收窄负例无可见失败），补丁后 E1~E6 全绿（vitest 退出码 0）。
- CLI 复演：`keel scenario a2|a3|a4|a5` 与 `keel hotswap` 随 apps/keel 测试 9/9 绿（集成面修复后，见 03 稿 §4.5）。

## ⑤ 不可观察面（D5 行登记）与人工补声明记录

- echo 无外部 config、无原生 IO、无模型调用——**不可观察面 = 空**。
- 人工补声明：无（manifest 三项声明面已完备覆盖行为）。
