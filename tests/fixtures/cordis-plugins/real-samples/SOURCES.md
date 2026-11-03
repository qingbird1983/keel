# 真样本（real-samples）来源登记与使用纪律

- 用途：Phase 2 合同 §5 的 **B5 真样本复跑**义务材料——按旧框架真实发布的第三方插件，检验兼容层与 `keel observe` 在"不是我们自己写的样本"上的表现。
- 结论落点：[docs/design/phase-2/08-real-sample-observation.md](../../../../docs/design/phase-2/08-real-sample-observation.md)（观察记录 + 边界表补充建议 + 工具缺陷清单）。
- **纪律**：这些目录是他方源码，**只读**。禁止为迁就 Keel 改写（[02 稿 §7 判据 1/2](../../../../docs/design/phase-2/02-adapter-skeleton.md)）；禁止格式化（`.prettierignore` 已长期排除 `tests/fixtures/cordis-plugins/`）。

## 1. 挑选标准（所有者给定）

1. **轻量**：单功能工具类，不带复杂数据库 / 重度前端；
2. **无复杂依赖**：纯 JS/TS，不依赖原生 C++ 模块；
3. **代表性**：覆盖"只读"与"有副作用"两类。

目录来源 = dshmarket.com/zh（商品目录 JSON：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，4380 条）。

## 2. 三枚样本

| 包名（版本）                                 | 作用（一句话）                                                                    | 类型              | 入口                                | 体量          | 运行时三方依赖           |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------- | ----------------------------------- | ------------- | ------------------------ |
| `dsh-plugin-local-life` @ 0.3.2              | 本地生活算术工具（预算/分账/单价/折扣/单位换算/清单/账本摘要/摊还/比价/菜谱成本） | **只读**计算      | `lib/index.js`                      | 2 文件 / 纯函数 | 0（按 npm 名 import 宿主包） |
| `dsh-scrape-webpage` @ 1.0.0                 | 抓取网页正文 + 统计关键词，可选下载内容图片到会话工作区，另发布识图分析器扩展点   | **有副作用**      | `lib/index.js`（`fetch.js` 执行层） | 5 文件 / 纯 JS  | 0（经宿主 shell 服务起 `curl.exe`） |
| `@99galaxy/dsh-turn-notify` @ 1.0.2          | 本轮结束时发 Windows 系统通知（Node 半 + 浏览器半）                                | 有副作用（通知）  | `lib/index.js`（**主体在 `client.js`**） | 2 文件 / 87 行 | 0                        |

| 包名                         | 仓库（`repository.url`）                             | 取回的 commit                            | 许可证 | 取回日期   |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------- | ------ | ---------- |
| `dsh-plugin-local-life`      | `github.com/863683348/dsh-plugin-local-life`         | `c7abe0935ceab43d784019fb42caf600b3aaadc5` | MIT    | 2026-11-03 |
| `dsh-scrape-webpage`         | `github.com/131CDA1/dsh-scrape-webpage`              | `7485af10c063579323058583c7f13e69c4c8bd21` | MIT    | 2026-11-03 |
| `@99galaxy/dsh-turn-notify`  | `github.com/99galaxy/dsh-turn-notify`                | `b748b96561be5541833fc0f5180da0cfa2efab4e` | MIT    | 2026-11-03 |

三个 commit 当日即各仓库 `main` 的头指针（`git ls-remote --heads` 复核一致），因此哈希本身就足以校验字节。三枚均为 MIT，上游 LICENSE 文本随目录一起取回。

## 3. 入库范围：只提交登记与观察产物，不提交他方源码

- 入库：本文件、`observed/<pkg>/**`（候选报关单 `legacy-index.candidate.json` + `legacy-index.gaps.md` + 观察 stdout `observe.txt` + 两趟账本 `legacy-index-ledger/**`）。证据文件名不叫 `*.log`——根 `.gitignore` 有 `*.log`，会把这些文件静默排除在提交之外。
- **不入库**：`<pkg>/` 三个源码目录（根 `.gitignore` 里三条）。理由三条：
  1. 他方源码进了我们的 git 历史就要跟我们的门禁一辈子——`pnpm lint` 实测在这三枚上报 **82 个 error**（`no-undef` 缺 Node 全局、`_error` 未用…），要过只能改他方代码（违反上面的纪律）或长期豁免整棵树；
  2. 复现性不靠拷贝：commit 哈希 + `git clone` 两条命令即可取回同一字节，且能同时拿到上游后续修订；
  3. 体量：三枚源码 + 其 `test/`、`tools/`、`release/` 共 327 KB / 59 文件，而真正需要长期留档的是观察产物。
- **`eslint.config.js` 里另有一条同范围 ignore**（`tests/fixtures/cordis-plugins/real-samples/**`）：eslint 不读 `.gitignore`，所以本地工作区里这棵树也不跟 lint 门禁。两处必须同时存在，缺一处 `pnpm lint` 就红。
- 取回命令（在本目录执行；需要网络与 GitHub SSH）：

  ```bash
  git clone --depth 1 git@github.com:863683348/dsh-plugin-local-life.git
  git clone --depth 1 git@github.com:131CDA1/dsh-scrape-webpage.git
  git clone --depth 1 git@github.com:99galaxy/dsh-turn-notify.git
  # 取回后删除嵌套 .git，避免被当成 submodule
  for d in dsh-plugin-local-life dsh-scrape-webpage dsh-turn-notify; do rm -rf $d/.git; done
  ```

  如果所有者更希望"源码随仓库走"：只需撤销根 `.gitignore` 那三条，`eslint.config.js` 的 ignore **保留**（它挡的是"拿我们的规则评他的代码"，与入库与否无关）。这是一次决定，不是两次修补。

## 4. 观察命令（本轮真实执行的形式）

```bash
node apps/keel/dist/main.js observe \
  --plugin tests/fixtures/cordis-plugins/real-samples/<pkg>/lib/index.js \
  --out  tests/fixtures/cordis-plugins/real-samples/observed/<pkg>
```

`--out` 按样本分目录不是讲究，是**必需**：三枚入口都叫 `index.js`，候选名由文件名合成，缺省会互相覆盖（缺陷 D1，见 08 稿）。

## 5. 探针（未入库，写在系统临时目录）

`probe.mjs` = 用记录代理喂 `apply(ctx, config)`，录下真实插件触碰的旧形状面；
`probe2.mjs` = 用**真实承接层 ctx**（in-process）喂同一个 `apply`，看未映射面露出什么形状。
两份脚本只做读取与记录，不发网络、不写业务文件；结论摘录在 08 稿 §3/§4。
