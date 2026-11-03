---
name: p-016-vitest-glob-missed-plugin-tests
description: vitest include 的 glob 少写一层目录导致整个目录树的测试静默不被收集——"全绿"可能是"根本没跑"
metadata:
  type: pitfall
---

# P-016 · 测试收集范围少一层 glob = 测试静默不跑

**现象**：切片④给插件 B 建包内单测（`packages/plugins/file-write/test/`）后发现它不被 vitest 收集。根因：根配置 include 写的是 `packages/*/test/**/*.test.ts`，而插件在 `packages/plugins/<name>/test/`（两层）——**第一个插件的 echo 单测从转正那天起就从未被主线门禁跑过**，一切显示"全绿"。

**为什么危险**：这不是"测试失败被掩盖"，而是"测试存在感被静默吞掉"。绿色给了错误的安心感；被补收的测试一旦有错，修完 include 后门禁会当场红（本轮补收 3 例 echo 单测恰是绿的，属于侥幸）。与 [[p-012-观察命令的accept不等于观察到了东西]] 同族：**"绿"要先问"跑了多少"**。

**判据与动作**：

1. 新增测试目录层级时，把"该目录下测试文件数被 vitest 收集"当作验收断言的一部分（跑一次 `vitest run --reporter=verbose` 数文件，或对比 `find -name '*.test.ts'` 与收集清单）。
2. 新包/新目录落位后，第一次跑门禁前先确认收集范围命中（glob 的 `*` 只跨一层，`**` 才递归）。
3. 报告测试数字时同时报文件数（"56 文件 420 测试"而非裸"420 测试"）——文件数突变是收集范围变了的信号。

**如何发现本条**：切片④显式传包内单测路径给 vitest，结果输出只有 1 个文件——显式路径也被 include 过滤，才暴露 include 缺层。
