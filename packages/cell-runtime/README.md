# @keel/cell-runtime

Cell 执行单元的进程体：一次 Agent Run 独占一个 OS 进程（"水密隔舱"，ADR-0005）——舱内崩溃不级联，越界效果必有声明。

## 职责

- **Cell 进程体**：承载一次 Run 的执行；经 stdio JSON 行帧与 Keel Core 结构化通信（唯一通道，ADR-0001 语言解耦点）

- **私有工具表**：只可见本 scope 注册的工具（可见性由 Core 上下文管理器裁决，本包不做本地注册表）

- **越界效果声明发起端**：一切越界副作用先发 `EFFECT_DECLARED`（含补偿语义）再执行——"先声明后动手"

- **无凭证、无直连网络**：模型调用必经 Core 网关，工具调用必经 Core 授权（`auth.check`）

## 当前状态

✅ **切片③④ + R3/R4 已落地**：stdio JSON 行帧协议（契约 §3.1，`FrameConn`）/ Cell 进程体（`startCell`：私有工具表 + `toolCallTimeoutMs` 硬强制）/ CellClient（§3.3 可见面客户端）/ EFFECT\_DECLARED 发起端（`effect.declare`）/ 迁移钩入口（A5，兼恢复挂载通道）/ 补偿动作分发（`compensation.exec`，宿主补偿执行器经一次性新 Cell 调用）/ 快照索取面（`cell.snapshot`）/ **受治理写入句柄 `ctx.workspace.create/overwrite`（`workspace.write`，收据由宿主签发）/ AOP 拦截器链 / `setup(ctx)` + `ctx.effect` + `cell.dispose` 生命周期 / `toolCallId` 去重**。验收 A2/A3/A4 与 R3/R4 的真实进程集成测试见 [tests/](../../tests/)。

## 目录与开发

```text
src/    实现
test/   单元测试（与 src/ 一一对应镜像）
```

```bash
pnpm --filter @keel/cell-runtime typecheck
pnpm --filter @keel/cell-runtime build
pnpm test   # 全仓测试（根目录执行）
```

## 关联文档

- 通道与帧格式：[docs/design/phase-1/01-core-api-contract.md](../../docs/design/phase-1/01-core-api-contract.md) §3.1

- 隔离决策：ADR-0005
