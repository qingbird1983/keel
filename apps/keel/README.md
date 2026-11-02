# keel（CLI）

Keel 的命令行演示载体——Phase 1 验收场景的执行入口：装配 manifest、跑 demo Run、执行恢复演练。

## 定位

- **薄壳**：只做参数解析与编排调用，业务逻辑全部下沉 [`packages/`](../)
- **验收入口**：Phase 1 八条验收场景（A1~A8）经由本 CLI 触发并记录结果

## 计划命令（随切片落地）

| 命令                   | 作用                                 | 对应验收 |
| ---------------------- | ------------------------------------ | -------- |
| `keel run <manifest>`  | 装配 manifest 并启动一次 demo Run    | A1/A2    |
| `keel recover <runId>` | 恢复演练：`recover.plan` + `execute` | A3       |
| `keel replay <runId>`  | 从账本重放决策序列（审计归因）       | A6       |

## 当前状态

🚧 **Phase 1 脚手架占位**——命令随纵向切片逐个点亮。施工顺序见 [docs/roadmap/phase-1-mvp.md](../../docs/roadmap/phase-1-mvp.md)。

## 开发

```bash
pnpm --filter keel typecheck
pnpm --filter keel build    # 产物 dist/main.js（bin 入口）
```
