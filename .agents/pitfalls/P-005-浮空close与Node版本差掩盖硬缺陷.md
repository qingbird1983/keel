# P-005 浮空 close 遇上 Node major 差：CI 常年绿灯，本机偶尔红灯

- 环境：2026-11-03 Phase 2 切片①文档轮的 `pnpm clean` 起全链核对，测试门禁首次 exit=1

## 现象

- **226 项断言全过，但 `pnpm test` 退出码 1**：vitest 汇总行写着 `Errors 1 error`，内容是未捕获异常
  `A FileHandle object was closed during garbage collection ... Please close FileHandle objects explicitly`（File descriptor 4 → `keel-ledger-*/agent-1/sess-1/run-1/seg-000003.jsonl`）
- 归属指向 `packages/core/test/ledger.test.ts` 的"段滚动"用例；**此前多轮本地与 CI 都全绿**——同一条命令红得不稳定。
  同一处报错出现过**两个成因**（生产代码的浮空 close + 测试实例从未关闭），见下方根因 3/4
- CI（Node 22）与开发机（Node 26）跑同一套门禁，缺陷只在新 major 上现形

## 根因

1. 生产代码：`Ledger.rollSegment()` 写的是 `(await w.opening).close();` —— **close 没 await**。
   关闭真正完成在线程池里；JS 侧此刻已不再引用那个句柄对象，GC 时机一到，Node 的 finalizer 再关一次。
2. Node 语义变更：GC 期间关闭 FileHandle 从 deprecation warning 升为**硬错误**（24+）。Node 22 只是静默 → CI 永远绿。
3. 为什么"偶尔"红：是否命中取决于 GC 何时回收该对象——**这类缺陷不能用"复现跑一遍"来验证**，必须写成与时机无关的断言。
4. 修完浮空 close 后错误**仍然出现一次**，这次指向另一个同源口子：测试 rig 里 `new Ledger(...)` 的**写入实例没登记、用例结束前没 close** → 当前段的句柄一直被开着，实例被丢弃后同样落到 GC 手里。
   即"未 await 的释放"和"从未释放的持有"是同一件事的两面：**只要有一条路径让句柄的关闭时机依赖 GC，Node 24+ 就把红灯变成随机事件**。

## 修复

- `rollSegment` 改为 `const closing = await w.opening; await closing.close();`（在串行队列内，顺序天然成立）；
  close 失败按写失败锁存 fail-stop，不静默。
- 回归测试 `packages/core/test/ledger.test.ts` 旁边**独立成文件** `ledger-fd-release.test.ts`：
  断言口径 = 可确定性观察的"awaited 性"——`checkpoint()` 承诺 resolve 时，被滚掉的旧段句柄 close 必须已完成。
  实测证明它有效：把生产代码改回浮空写法 → 该用例必红；改回来 → 绿。
- CI 加 Node 矩阵 `[22, 26]`（下限 = `engines`，上限 = 开发机同 major），`fail-fast: false`；
  规范 `standards/04` §3 补一条：Promise 型释放必须 await。
- **修完生产代码后同一错误又出现一次**，指向同源第二个口子：测试 rig 绕过 `newLedger` 登记器直接 `new Ledger(...)` 的写入实例从不 close
  → 当前段句柄被丢给 GC。两处（`ledger.test.ts` 段滚动用例 + 新回归用例）都改走"构造即登记、`afterEach` 统一 close"，
  并把 `newLedger` 扩出 `segMaxBytes` 参数。全套连跑 2 次 + 目标文件连跑 3 次，`Errors` 行不再出现。

## 预防

1. **"全部测试通过"不等于门禁通过**：看 vitest 的 `Errors` 行与退出码；uncaught exception 是运行时在替你报缺陷，不是测试噪声。
2. 浮空释放（`.close()` / `.sync()` / `child.kill()` 不 await）一律视为资源释放路径不确定；组件自己的失败语义决定失败后是锁存还是上抛。
3. **只要有一条路径让句柄的关闭时机依赖 GC，红灯就是随机事件**——"未 await 的释放"与"从未释放的持有"要一起堵：生产代码 await，测试 rig 每个写入实例登记 close（含失败路径）。
4. **想断言"某事被 await 过"**：包装被观察的方法，让完成标志只在真实完成后置位，再断言上层承诺 resolve 时标志已置位。
   细节坑：`FileHandle.close` 是**实例自有属性**（原型上没有），原型补丁无效 → 只能包装 `fs/promises.open()` 的返回值
   （`vi.mock("node:fs/promises", …)` 工厂里 `...actual` 展开，只替 `open`，其余保持原生）。
5. mock 核心模块的用例单独成文件：`vi.mock` 作用范围是整个测试文件，别把同目录其它用例拖下水。
6. 本地与 CI 的 runtime major 差异 = 门禁盲区；要么矩阵覆盖，要么锁到同一 major。发现"只在新版本现形"的缺陷时，先问"下限环境是不是一直在替我们沉默"。

## 关联

- CHANGELOG 0.1.025；H-018；`packages/core/src/ledger.ts`（rollSegment）；`docs/standards/04` §3、`docs/standards/05` §5；[P-004](P-004-类型检查依赖构建产物.md)（同一母题：干净/新环境才是证据）
