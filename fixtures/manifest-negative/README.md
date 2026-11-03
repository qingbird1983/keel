# manifest 负路径 fixtures（A5 语义）

manifest 稿 §8"四类畸形均被拒"的实体化样例组（2026-11-02 切片⑤）。每枚 = 单一病灶，
供 host 批量校验测试与 `keel validate --dir --expect reject` 复演消费；任一文件未被拒即失败。

| 文件                           | 预期拒绝原因                                                                  | 装配五步归属     |
| ------------------------------ | ----------------------------------------------------------------------------- | ---------------- |
| `missing-net-allow.json`       | 越界能力 net.fetch 缺 `allow`（语义层必填，Schema 不强制——C-M2 分层）         | 第 2 步 权限交叉 |
| `boundary-no-template.json`    | 越界能力 fs.write 补偿模板池为空（I4：补偿不可能被省略）                      | 第 2 步 权限交叉 |
| `policy-with-permissions.json` | policy 声明 permissions（Schema allOf `maxItems:0`）                          | 第 1 步 结构     |
| `hook-unknown-name.json`       | hook 名超出契约白名单（enum 封闭）                                            | 第 1 步 结构     |
| `bad-meta-name.json`           | `meta.name` 违反 kebab-case pattern                                           | 第 1 步 结构     |
| `unknown-top-field.json`       | 顶层未知字段（additionalProperties:false）                                    | 第 1 步 结构     |
| `capability-with-hooks.json`   | 能力插件持钩子面（capability 分支 `hooks: maxItems:0`；01 稿 #2 拆支归 #14）  | 第 1 步 结构     |
| `policy-with-timeout.json`     | policy 声明 `resources`（策略舱没有工具时限这个量，插话预算只有契约 §7 一处） | 第 1 步 结构     |

后两枚由 Phase 2 切片④（B4 的装配期拒绝面）补入：D 档 #7/#14 的"能力插件装钩子"与"为策略另造时限"
两条尝试，在装配五步的第 1 步就整份拒掉——不做"只收合法那几项"的部分接受（口径见
[phase-2/06 稿](../../docs/design/phase-2/06-policy-chain-and-d-tier-refusal.md) §3.2）。

预期错误码统一 `SCHED/MANIFEST-INVALID`（装配器五步任一失败的同码，见 manifest 稿 §6）。
正路径样例在 `../../docs/design/phase-1/schema/examples/`（两示例即正 fixtures）。
