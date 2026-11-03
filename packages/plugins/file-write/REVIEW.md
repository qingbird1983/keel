# 插件 B `file-write` 评审留痕（02 稿 §5 模板；转正记录 2026-11-04，切片④）

> 口径：机器层（禁面扫描）每次门禁都跑；本文件是人工层的一次性留痕。引反面教材只写行号不抄判据串（02 稿 §7 措辞纪律）。

## ① manifest 摘录（能力 / 资源 / 补偿三项）

- **能力**：`tool.provide`（工具清单在代码内）+ `fs.write` 带 `allow` 清单（范式根 `fs:/tmp/keel-workspace/**`，部署时按真实根目录替换）——越界能力有显式 allow，装配期进 `ASSEMBLY_RECORDED.permissions` 基线。
- **资源**：`toolCallTimeoutMs: 10000`（capability 必填，硬强制）。
- **补偿**：模板 `fs.write.done` → `class:"reversible"` + `builtin fs.remove` + `idempotency:"natural"`（ADR-0016）；执行面在宿主，只认收据（ADR-0018）：`created:true` 且 identity 复核通过才删——插件零撤销代码。

## ② 01 清单 18 行逐条（不适用 + 一句理由）

| 行  | 判定   | 理由                                                                                              |
| --- | ------ | ------------------------------------------------------------------------------------------------- |
| A1  | 不适用 | 无任何提示词面——工具只写文件并返回 `{path, bytes}`                                                |
| A2  | 不适用 | handler 只返回结果对象，不触碰轮次控制                                                            |
| A3  | 不适用 | 不读不算任何预算量（机器扫描零命中）                                                              |
| A4  | 不适用 | 结果只含 `{path, bytes}`，不夹带指令                                                              |
| B1  | 不适用 | 权限面 = manifest 声明；运行期无任何申请动作，越界由授权器 + 守卫当场拒绝（e2e B-E2）             |
| B2  | 不适用 | 身份由宿主通道盖章；代码不持有任何会话标识                                                        |
| B3  | 不适用 | 零服务定位：模块零 import，唯一宿主接触面 = 能力句柄 `ctx.workspace`（R3 受治理能力，非通用句柄） |
| B4  | 不适用 | package.json 零依赖字段；import 清单 = 空（B4-deps/B4-import 机械判定双零）                       |
| B5  | 不适用 | 工具体只有 name/schema/handler 三字段，无可调度量                                                 |
| C1  | 不适用 | 无扩展点发布/取用——单插件单工具，零插件间通道                                                     |
| C2  | 不适用 | 无事件总线用法                                                                                    |
| C3  | 不适用 | 无共享状态：模块级只有类型别名与工具表，无跨调用可变态                                            |
| C4  | 不适用 | 行为唯一事实源 = 本目录 manifest + dist 构建产物，无外部组合层                                    |
| D1  | 不适用 | 入口 = Keel 原生形状（默认入口装载 `export const tools`），不依赖外部框架世代                     |
| D2  | 不适用 | 工具体字段 = 契约 CellTool 形状，五步校验 + 装载期发布双重核验                                    |
| D3  | 不适用 | 单进程 Cell 承载全部功能，无浏览器半                                                              |
| D4  | 不适用 | 非观察工具；验收 = 真进程账本留痕（B-E1~E5），无自评拆问面                                        |
| D5  | 见 ⑤   | 不可观察面登记如下                                                                                |

## ③ 看代码三件事

- **入口形状**：`src/index.ts` 仅 `export const tools`（单元素）；宿主入口（cell-runtime `main.ts`）装载 → 本地登记 → 跨进程发布 → markReady。
- **工具体字段**：`name: "write_file"` + JSON Schema（object / path+content 必填 / additionalProperties false）+ handler 纯业务（`ctx.workspace.create` 一行业务 + 返回摘要）——治理三件事（守卫/声明/补偿）全由 manifest `governance` + `compensation` 驱动（ADR-0015/0016/0018），handler 内零治理调用、零撤销代码。
- **import 清单**：零（类型为本地结构别名，与插件 A 同口径）。无 snapshot / compensations / migrate / setup / dispose 导出 = 无资源 Cell。

## ④ 门禁与真进程用例退出码证据（2026-11-04）

- 真进程 e2e（`tests/native-file-write-e2e.test.ts`，B-E1~E5）：**红测先行证据**——转正件缺席时 e2e 红（`Test Files 1 failed`，ENOENT 报关单缺失），转正件就位后 5/5 绿（vitest 退出码 0）。B-E1 补偿闭环（RUN_FAILED → builtin fs.remove → 文件消失 → `EFFECT_SETTLED.receipt.created:true` + identity → `COMPENSATION_EXECUTED{removed}`）；B-E2 越界拒零部分生效；B-E3 同 `toolCallId` 重试复用收据；B-E4 补偿器只读账本幂等重放；B-E5 预存在目标 → `WORKSPACE/EXISTS` 且不被误删。
- 禁面扫描：`native-plugin-scan: clean`（退出码 0）。
- 包内单测（`test/file-write.test.ts`，3 例）随主线 vitest 全绿——切片④修正 vitest include 缺层后，插件单测首次进主线门禁（此前 echo 的包内单测未被收集，属盲区，已修）。

## ⑤ 不可观察面（D5 行登记）与人工补声明记录

- **不可观察面**：allow 清单根的部署替换（仓库件给范式路径，e2e 期替换为临时根——与切片③ fixture 同口径）；`ctx.workspace` 的宿主侧行为（路径归一/realpath/identity）在 `packages/host` 单测覆盖，插件侧不可见。
- 人工补声明：无（manifest 三项声明面已完备覆盖行为；覆盖写不在本工具语义内，需覆盖时走 `record-only` 或插件补偿——`fs.remove` 不认覆盖写收据，08 稿 §10）。
