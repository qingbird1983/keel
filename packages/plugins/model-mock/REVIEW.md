# 插件 `model-mock` 评审留痕（Phase 4 切片③，2026-11-04）

> 口径：机器层（禁面扫描）每次门禁都跑；本文件是人工层的一次性留痕。
> 定位（02 稿 M7）：进 CI 的确定性剧本，承载 D2/D4/D6 全部机械断言。

## ① manifest 摘录

- **能力**：无（`permissions: []`——model 分支 schema 强制为空；模块是宿主内可信代码，
  出网是职责本身，不走 Cell 能力表）。
- **资源**：`{}`（model 分支不允许 `toolCallTimeoutMs`；唯一时限是 `model.timeouts.idleMs`）。
- **补偿**：`templates: []`——模型调用无副作用，无可补偿物。
- **密钥**：`auth.ref = KEEL_MODEL_MOCK_KEY`（环境变量**名**，非明文）；装配期只查存在性，
  模块经 `create({secrets})` 拿到 resolver，本实现根本不需要真值。

## ② 禁面（K6 / 04 稿 §4）

| 规则      | 判定   | 证据                                                                                   |
| --------- | ------ | -------------------------------------------------------------------------------------- |
| E2-env    | 零命中 | 模块不读进程环境；密钥只经注入的 `secrets.resolve`                                     |
| E5-key    | 零命中 | 源码无密钥形态字面量、无日志输出                                                       |
| M1-cost   | 零命中 | 只报三桶 `usage`，不自报费用；网关对带 `cost` 的模块直接拒绝（UPSTREAM_PROVIDED_COST） |
| B4-deps   | 零命中 | `package.json` 无任何依赖字段                                                          |
| B4-import | 零命中 | 模块零 import（纯 TS 常量与生成器）                                                    |

## ③ 看代码三件事

- **入口形状**：`export function create({ model, secrets })` → `{ invoke, stream }`；结构类型，
  不 import `@keel/*`（插件零依赖纪律）。
- **计量形状**：每片报**累计**三桶（最后一片即终值；断流时最后一片仍可计价）；费用由 Core 按
  manifest 价格表算。剧本：`ok` / `throw` / `slow` / `no-usage` / `chunksBeforeThrow` / `pauseAfterFirstMs`。
- **空闲看门狗**：`model.timeouts.idleMs` 到点即抛错，网关按断流口径结算已产出部分（M5 第 2 条）。

## ④ 门禁与用例证据（2026-11-04）

- 包内单测 `test/model-mock.test.ts`（6 例，CU 主线收集）：计量形状 / 剧本确定复现 / 看门狗 / 断流。
- 集成 `tests/model-kind-e2e.test.ts`（12 例，真实装配）：D2 峰谷计价与预算夹限、D4 密钥零泄漏、
  D6 超时/断流/看门狗收束、成本权威拒绝、表面事件词汇。
- 禁面扫描：`native-plugin-scan: clean`。

## ⑤ 不可观察面

- 剧本参数（`params`）是**测试输入**，不是运行期配置：生产装配不会带这些参数，模块默认走 `ok`。
- 空闲看门狗只能观察"停顿被中止"这一结果；上游连接是否真正释放取决于模块实现（mock 无连接）。
