# H-035 切片② Profile 装配面落地

- 日期：2026-11-04
- 主题：Phase 4 切片②——Profile 装配面端到端（锚 D1）

## 本轮做了什么

1. **契约与 manifest 修订 R2 + R9~R13 落地**
   - `events.ts`：`ASSEMBLY_RECORDED` 追加可选 `profile{name,version}` / `plugin{id}`。
   - `scheduler.ts`：`assembly` 接受单条或数组，按序作为 run **首批**事件写入（单件路径形状不变）。
   - `keel-plugin.schema.json`：`kind` 扩五值；新增 `model` / `engine` 两段与两段 `if/then`；
     model/engine 的 permissions/resources/compensation/hooks/governance/trust 按设计封空。
   - `assembler.ts`：`KINDS` 五值；`validateModel`（presence-only 密钥、价格表键集合、三桶、峰谷窗口、idleMs ≤ 300s）
     与 `validateEngine`（只允许 `model.adapter`、tools 无重名、maxSteps 1~100、loop=react）。
2. **Profile 装配面**（`packages/host/src/profile/`）
   - `parse.ts`：严格 YAML 子集（块映射/序列/标量/注释；锚点/别名/flow/多文档/块标量/重复键 = 硬失败+行号）。
   - `schema.ts`：复用 `schema-validator`（未扩关键词）。
   - `assemble.ts`：`loadProfile`（1~3 步，无运行时）+ `assembleProfile`（4~6 步，按 kind 拉起、
     全部就绪后接策略）；组合执行器按 `scope + tool` 路由；engine.tools 用**真实注册结果**复核恰好一个提供者。
   - `wireCell` / `cell-server` 增可选 `onToolChange` 观察回调（不改裁决/分区写）。
3. **CLI**：`keel validate --profile`（只校验）；`keel run --profile`（capability-only 可跑；含 engine 明确留切片④）；
   `--profile` 与 `--manifest/--plugin` 互斥。
4. **Cell 入口修正**：`toolCallTimeoutMs` 的校验从真值判断改为类型判断（0 合法）——见 P-019。
5. **测试与夹具**：`packages/host/test/profile.test.ts`（11 条）、`tests/profile-assembly-e2e.test.ts`（D1-a~e 5 条）、
   `apps/keel/test/cli.test.ts` 新增 4 条；夹具在 `tests/fixtures/profile/`（五 kind + 坏清单 + 跨 scope）。

## 验证

- 六道门禁全绿：format / lint / typecheck+build / test **58 文件 442 测试** / 扫描（既有规则未变）。
- D1-a：五 kind 隔离环境（model 与宿主同 pid；engine/capability 子进程不同 pid；policy 舱；observation 无运行时）。
- D1-b：N 条 `ASSEMBLY_RECORDED` 为 run 首批事件、按声明序、带 `profile`/`plugin`；pid 工具经组合执行器路由。
- D1-c：坏 manifest 混入 → 整份拒绝、零事件；D1-d：跨 scope 工具互不可见；D1-e：绝对路径即拒。
- 回归：原有三件套 e2e、cell-crash、throughSeq、快照、策略链等全部保持绿。

## 遗留与下一步

1. **切片③ model kind**：R1/R4/R5——表面事件、`MODEL_USAGE` v3（三桶/峰谷/`pricedBy`）、网关计价与超支不穿透预算；
   `mocks/model-mock` 标杆 + DeepSeek 真适配器（不进 CI）。现有 profile 已能把 model 模块构造为宿主上游，但尚未接进网关。
2. **切片④ engine kind**：R6 `engine.step`、ReAct 标杆、D3 真进程与 kill 故障半径、`run --profile` 的引擎驱动。
3. 切片②未做：模型上游接入网关（现仅构造与宿主驻留验证）；policy 在 profile 里的 `rt.policies` 归属由装配器 close 统一收束。

## 已提取沉淀

- P-019（0 当缺省值 → 空 resources 插件装载即崩）。
- P-014 追加"再次发生"（Schema 用 `minProperties` 越过校验器关键词子集）。
