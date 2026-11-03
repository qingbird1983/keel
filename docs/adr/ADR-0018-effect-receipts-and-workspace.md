# ADR-0018：效果收据与受治理 Workspace

- 状态：接受
- 日期：2026-11-03
- 关联：[07 重构计划](../design/phase-3/07-runtime-context-refactor.md)；[ADR-0016](ADR-0016-builtin-compensation-registry.md)；[ADR-0017](ADR-0017-runtime-context-layering.md)

## 背景

切片③的 `fs.remove` 只按 `EFFECT_DECLARED.targetSummary.path` 删除，没有证明“这个文件是本次 Run 新建的”。只要声明路径指向一个预存在文件（或覆盖写），内置补偿就会误删。`guard` 查的也是参数，不是实际 IO；字面 glob 挡不住 `..`、符号链接和 Windows 路径归一差异。

根因：**声明（intent）被当成了事实（receipt）**。外部副作用必须有“确实发生、身份可核对”的凭证，补偿才能动作。

## 决策

1. **业务效果流程改为 intent → receipt → settle**：
   - `EFFECT_DECLARED` 仍表示意图（AOP 在 handler 前写）；
   - 实际受治理操作完成时，由 Host 追加 `EFFECT_SETTLED`，携带可选 `receipt`（**扩展既有字段，不新增事件类型**）；
   - 补偿只对带有效 receipt 的内置动作生效。
2. **`EffectReceipt` 最小字段**：
   `opId`（= effectId）、`kind`、`mode`（`create|overwrite`）、`target`（绝对路径）、`existed`、`created`、`overwritten`、`identity`（创建后的 `dev/ino/size/mtimeMs/sha256`）、`before`（可选）、`workspaceRoot`、`timestamp`。
3. **新增 Host 侧 `Workspace` 能力**（`packages/host/src/workspace.ts`）：
   - `create`：`open(path,"wx")` 独占创建；目标已存在即失败；只有创建成功才产生 `created:true` 收据；
   - `overwrite`：显式模式；不享受 `fs.remove` 内置补偿（旧内容不可恢复）；
   - 路径必须是绝对路径；`path.resolve` 归一后必须命中本 Run `fs.write.allow`；父目录 `realpath` 后再核一次，拒绝符号链接逃逸、`..` 越界、设备文件；
   - 收据的 `identity` 来自实际文件句柄（`fstat` + 内容 SHA-256），不回填声明参数。
4. **新增 Cell→Host op `workspace.write`**：入参 `{effectId, mode, path, content, toolCallId?}`；Host 先核对该 effect 属于本 Run 且未结算，再写文件、追加收据、返回收据。写入过程与收据写入分离；收据写失败时尽力回滚本次创建（unlink），失败则让错误可见。
5. **`fs.remove` 只认收据**：要求 `receipt.created === true`、目标路径等于 `receipt.target`、当前文件 identity 与收据一致；不匹配 → 拒绝并升级，不删除。无收据的候选不进入内置删除（按“未发生”处理）。
6. **多 effect**：每个实际操作各自结算并产生收据；未执行的效果没有收据，不参与补偿。`toolCallId` 随 `tool.exec` 下发，供重试去重（R4 落地）。

## 备选与否决

- **继续按声明路径删除**：无法区分预存在/覆盖写；否决。
- **插件自报收据**：不可信，等于让被审者自证；否决。
- **新增 `EFFECT_RECEIPT` 事件**：收据与“是否完成”同一次写入更简单，且 07 稿 D2 要求优先扩展字段；保留为将来需要独立生命周期时的选项。
- **Cell 内直接写文件再上报**：无法阻止声明与真实路径漂移，也无法保证 `O_EXCL`；否决。

## 后果

- 正面：误删路径被结构性关闭；覆盖写不再伪装成可逆；补偿有可核对的凭据。
- 负面：写文件必须走 `ctx.workspace` 能力（AOP 之外的唯一黄路径）；raw IO 插件的内置补偿失效，必须用 record-only 或自定义补偿。
- 边界：`identity` 复核与 unlink 之间仍有极小的 TOCTOU 窗口（Node 无 `openat`），按“风险已登记、不宣称绝对原子”处理；跨设备/网络文件系统的一致性不在本阶段承诺。
- 兼容：旧账本没有 `receipt`；内置删除对新旧账本都要求收据，因此旧账本的 `fs.remove` 候选会被跳过（fail-closed），不会误删。
