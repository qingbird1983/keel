# P-012-观察命令的ACCEPT不等于观察到了东西

> 单篇 ≤ 80 行；已检索 P-007（测试绿色要当场验真）——**那篇管"测试通过 ≠ 主张成立"，本篇管"工具给自己打的分 ≠ 它声称的那件事"**：一个是证据判读，一个是判据本身的构造缺陷。两者不重叠。

## 现象

Phase 2 切片⑥ 真样本第一批：对三枚真实第三方 Cordis 插件跑 `keel observe`，三枚的输出**一字不差**：

```
pass 1: state=failed events=9 names=[]
pass 2: state=failed events=9 names=[]
validate: ACCEPT（legacy-index@0.0.0，cap=）
EXIT=0
```

而真实情况是三枚各死于不同原因：一枚连模块都没装载（`ERR_MODULE_NOT_FOUND: '@deepseek-ai/schemastery'`），两枚被承接层的入口形状门拒掉（`ADAPTER/ENTRY-UNKNOWN`）。产物 `gaps.md` 里只有两条与本批无关的通用待审项；三枚的候选/缺项文件 **md5 相同**，账本去掉时间戳后逐条相同。

另有一条：三枚入口都叫 `index.js`，候选名由文件名合成 → 三枚**写同一组文件名**，第二批直接覆盖第一批的产物（本轮靠给每枚单独 `--out` 才保住证据）。

## 根因

**一个命令的"结论"由三个互不蕴含的判断拼成，而代码只算了其中一个：**

1. 退出码与 `validate:` 那行问的是"**这张候选单子能不能过五步校验**"。空候选（`permissions: []`）本来就过校验 → `ACCEPT` + 0。**"装载成功"和"观察到任何面"根本没进判据**。
2. 舱的诊断走 stderr（与内核默认入口同一约定），宿主 `stdio: ["pipe","pipe","pipe"]` **开了管道但全仓库没有一处消费 `CellProcess.stderr`**（`grep stderr packages/host/src apps/keel/src` 命中 0）→ 崩因既不入账本也不打印，`RUN_FAILED` 只剩通用文案 `CELL/CRASH`。**三个根因被压成一个码**，观察证据因此失去区分力。
3. 命名取自 `path.basename(pluginPath)`：真实包的入口是固定的 `lib/index.js`，文件名不携带身份信息 → 撞名。同目录 `package.json > name` 才是唯一事实源，但没读。

## 修复

本轮**没有改代码**（铁律 1：切片⑥ 设计稿未定稿）。当前只做了证据保全与登记：

- 每枚样本单独 `--out …/observed/<pkg>`，并把 observe 的 stdout 存进同目录（`observe.txt`）；**别命名成 `observe.log`——根 `.gitignore` 有 `*.log`，证据文件会被静默排除在提交之外**（本轮第一次提交前 `git add --dry-run` 才看见它没进去）；
- 崩因靠单独起舱收 stderr 取证：`node packages/cordis-adapter/dist/cell-entry.js '<bootstrap json>'`，stderr 上有 `[cordis-cell-crash]` 全栈；
- 三条缺陷编号 D1/D2/D3 落 [08 稿 §5](../../docs/design/phase-2/08-real-sample-observation.md)，与 D4（旧 ctx 未映射命名空间是裸 `undefined` → TypeError，无改法去处）、D5（观察只读代码不读外部声明层）一起在切片⑥ 定稿后处置。

## 预防

- **用任何"工具自评"的结论前，先把它声称的那件事拆成两三问，逐问核对代码里算了哪几问**。这里是三问：装载成功了吗？观察到面了吗？候选能过校验吗？只算最后一问的命令，其 `ACCEPT` 对前两问没有任何承诺。
- **空产物必须响亮失败**：观察/合成类命令遇到"零事件、零工具、零 cap"一律非零退出并在结论行写明"没有可审核的东西"；`ACCEPT` 只描述校验，不描述观察成败。
- **凡开子进程的诊断流，要么消费要么显式丢弃**（`stdio: pipe` 而无人读 = 静默丢弃，且大输出还能堵死管道）。收进来的尾部若干行要挂到既有的终态事件上（`RUN_FAILED{CELL/CRASH}` 附摘要），注意 P-009：**跨边界不会自动带，必须显式塞进载荷**。
- **产物命名用身份事实源，不用文件名**：包名（`package.json > name`）> 目录名 > 文件名。合成/观察类落盘前先问一次"两个输入会不会写同一个文件"。
- 机械核对一条（改动 `apps/keel/src/observe.ts`、`cmd-observe.ts` 后跑）：拿一个**已知装载必败**的入口（如 `tests/fixtures/cordis-plugins/real-samples/<pkg>/lib/index.js`）跑 observe，断言退出码非 0；当前该断言为红——它就是这个缺陷的可执行哨兵。

## 归属

Phase 2 切片⑥（真样本第一批 / Windows / Node 26）；**本轮无代码改动**，只有证据登记与缺陷编号。相关：08 稿 §5、合同 B5、P-007（判读证据）、P-009（跨边界丢东西）。
