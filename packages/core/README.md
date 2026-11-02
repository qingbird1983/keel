# @keel/core

Keel 内核控制面：调度、授权、预算、账本、上下文治理、模型网关、策略扩展点全部收敛于此——**插件能装配的只有能力，控制流不可替换**。零运行时依赖。

## 组件一览（对应 [Core API 契约](../../docs/design/phase-1/01-core-api-contract.md)）

| 模块                     | 职责                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `scheduler`              | Run 生命周期 + 轮循环**固定序列**（不可插件化）；预算耗尽三档处置；hook 重试钳制        |
| `authorizer`             | 白名单 + 默认拒绝（fail-closed）；每次拒绝必写 `AUTH_DENIED` 留痕                       |
| `budget`                 | scope 链（run ⊃ session）额度预扣/实结、多退少补；同请求号幂等，不重复计费              |
| `ledger`                 | 只追加分段 JSONL 账本；每轮 `CHECKPOINT` 强制落盘一致点；写失败 fail-stop；撕裂安全读   |
| `context`                | 工具表按 scope 分区互不可见；`TOOL_SCHEMA_CHANGED` 仅传播受影响 scope（V1 结构性防御）  |
| `gateway`                | 模型调用唯一通道：授权 → 预扣 → 代理 → 权威实结；同请求号重放不重打上游（ADR-0003）     |
| `hooks`                  | 策略插件唯一扩展面：四个白名单 hook，全部"建议/否决"型；超时/违规一律回落默认策略并留痕 |
| `events`/`errors`/`glob` | 账本事件表（契约 §5）、契约错误码、glob 方言等共享模型                                  |

## 不做什么（边界）

- 不含 Cell 进程隔离与装配器（见 [`@keel/host`](../host/README.md)、[`@keel/cell-runtime`](../cell-runtime/README.md)）
- 不含补偿执行器与恢复器（Phase 1 切片④落地）
- 不做资源硬强制与性能调优（Phase 1 范围合同明确排除）

## 五大不变量的落点

| 不变量         | 本包实现                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| 控制不可旁路   | 调度轮序列硬编码于 `scheduler`；hook 响应封闭键集校验，夹带"下一动作"字段即拒 |
| 故障不可级联   | 一切调用显式超时；账本写失败 fail-stop；网关故障只失败发起 Cell 本轮          |
| 状态不可丢失   | 每轮 `CHECKPOINT` 一致点；账本只追加、崩溃后尾部撕裂安全可读                  |
| 副作用不可无痕 | 账本全事件留痕；拒绝、hook 介入、预算流水皆可重放归因                         |
| 上下文不可污染 | 一切 context/tool 接口以 scope 为首参，不存在无作用域的全局接口               |

## 目录与开发

```text
src/    实现（上表各模块）
test/   单元测试（与 src/ 一一对应镜像）
```

```bash
pnpm --filter @keel/core typecheck   # 类型检查（src + test）
pnpm --filter @keel/core build       # 构建（仅 src → dist/）
pnpm test                            # 全仓测试（根目录执行）
```

## 关联文档

- 接口契约：[docs/design/phase-1/01-core-api-contract.md](../../docs/design/phase-1/01-core-api-contract.md)
- 架构总览：[docs/architecture/01-keel-overview.md](../../docs/architecture/01-keel-overview.md)
- 决策记录：ADR-0003（模型网关）、ADR-0004（账本一致点）
- 当前进度：[docs/roadmap/00-roadmap.md](../../docs/roadmap/00-roadmap.md)
