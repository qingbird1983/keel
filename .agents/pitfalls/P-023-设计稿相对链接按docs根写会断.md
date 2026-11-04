# P-023 设计稿里的相对链接按 docs 根写会指到不存在的路径

## 现象

打开 `docs/design/phase-4/04-contract-revision.md:5`，`[ADR-0021](../adr/ADR-0021-session-ledger-topology.md)` 解析成 `docs/design/adr/...`（不存在）；同理 `[契约](../design/phase-1/01-core-api-contract.md)` 解析成 `docs/design/design/phase-1/...`。Markdown 渲染器与编辑器一律 404。

## 根因

链接是照"以 `docs/` 为根"的直觉写的（写作者当时在 docs 根阅读），而 **Markdown 的相对链接基准是文件所在目录**：设计稿在 `docs/design/phase-N/`，多一层 `../` 才能回到 `docs/`。

phase-3/4 的设计稿成片如此（沿抄上一稿时把错误一起抄下来）；`docs/roadmap/` 与 `docs/adr/` 下的 `../adr/`、`../roadmap/` 反而是对的——这让人误以为风格统一。

## 修复

- 新写 `docs/design/phase-N/*.md`：用 `../../adr/`、`../../roadmap/`、`../../design/phase-1/`；同目录设计稿仍用 `01-xxx.md`。
- phase-5 的四份设计稿已按此写（本轮核对过全部 `](../` 出现处）。
- 既有 phase-1~4 的链接债**登记待修**（机械替换，但涉及多篇，按范围纪律单独一次提交）。

## 预防

- 复制旧稿当模板时，逐条数 `../` 的层数，不照抄路径。
- 若要机械校验，可加一条脚本规则：`docs/design/**` 里以 `](../` 开头的目标必须存在；当前无此门禁（登记 backlog，不顺手扩扫描器）。
