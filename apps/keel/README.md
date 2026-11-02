# keel（CLI）

Keel 的命令行演示载体——Phase 1 验收场景的执行入口：装配 manifest、跑 demo Run、恢复演练、审计重放、基准采集与验收场景一键复演。

## 定位

- **薄壳**：只做参数解析与编排调用，业务逻辑全部下沉 [`packages/`](../)；scenario 断言 = 账本事件存在性检查
- **验收入口**：Phase 1 八条验收场景（A1~A8）经由本 CLI 触发并记录结果
- 命令面与基准口径：[docs/design/phase-1/04-cli-benchmarks-fixtures.md](../../docs/design/phase-1/04-cli-benchmarks-fixtures.md) §2/§3

## 命令（切片⑤起全部可用）

| 命令            | 作用                                                                              | 对应验收 |
| --------------- | --------------------------------------------------------------------------------- | -------- |
| `keel run`      | 装配 manifest 并启动一次 demo Run                                                 | A1/A2    |
| `keel recover`  | 恢复演练：`recover.plan` + `execute`                                              | A3       |
| `keel replay`   | 从账本重放决策序列（审计归因，纯展示）                                            | A6       |
| `keel validate` | manifest 五步校验复演（单文件/目录批量）                                          | A5       |
| `keel hotswap`  | 热装配复演：迁移失败回退 + 原子切换                                               | A5 (V5)  |
| `keel bench`    | A8 四项基准采集（markdown 表格输出）                                              | A8       |
| `keel scenario` | 一键复演：`a2`（崩溃隔离）/`a3`（kill 恢复）/`a4`（补偿）/`a5`（装配校验+热装配） | A2~A5    |

参数细节见 `keel <cmd>` 无参时的用法输出。fixtures / schema 路径按仓库根解析，不依赖 cwd。

## 当前状态

✅ **七命令全量可用**（切片⑤）。基准数据与验收核对：[docs/design/phase-1/report.md](../../docs/design/phase-1/report.md)。

## 开发

```bash
pnpm --filter keel typecheck
pnpm --filter keel build        # 产物 dist/main.js（bin 入口）
pnpm build                      # 全量构建——Cell 子进程只能跑 dist，CLI 各命令前置
node apps/keel/dist/main.js scenario a2   # 复演示例
pnpm vitest run apps/keel/test  # 命令层冒烟（bin 全链）
```
