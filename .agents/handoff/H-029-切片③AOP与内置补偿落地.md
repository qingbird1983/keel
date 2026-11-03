# H-029-切片③ AOP 与内置补偿落地

- 日期：2026-11-03
- 范围：Phase 3 切片③（Cell-Runtime AOP + 宿主内置补偿 + DX 报告）；实现、文档与门禁均完成

## 本轮做了什么

1. **所有者两次要求**：① handler 保持纯业务，治理由底座按 manifest 自动完成；② 内置补偿 + 框架级拦截 + record-only 简化 + DX 对比报告，必须立刻落地。
2. **设计定稿**：[04 稿](../../docs/design/phase-3/04-cell-runtime-aop.md)（AOP 拦截器链）、[05 稿](../../docs/design/phase-3/05-builtin-compensation.md)（内置补偿 / record-only）、[06 报告](../../docs/design/phase-3/06-dx-compensation-report.md)（53 → 24 行）；[ADR-0015](../../docs/adr/ADR-0015-manifest-governance-and-cell-aop.md) / [ADR-0016](../../docs/adr/ADR-0016-builtin-compensation-registry.md) 接受。
3. **契约面**：`keel-plugin.schema.json` 新增 `governance`（仅 capability；数组 `tools[]`），record-only 只必填 `kind/class`（`if/then` 对 reversible/mitigable 强制 action/idempotency）；manifest 稿带日期注记。
4. **Cell-Runtime**：新增 `governance.ts`（计划类型、字段选择、守卫资源、SHA-256 规范化摘要）；`cell.ts` 加 `runGoverned`（guard → declare → handler）与只读 `ctx.effects`；`markReady` 校验计划点名的工具已登记；`main.ts` 从 bootstrap 读计划。
5. **Host**：新增 `governance.ts`（`compileGovernancePlan`）与 `builtins.ts`（`fs.remove` 闭集）；`SupervisedCell` 构造 bootstrap 时自动追加 `governance`（所有起舱路径共用，含热装配）；`CompensationExecutor` 按 `actionType` 分派，builtin 不 spawn 补偿 Cell，路径按 `ASSEMBLY_RECORDED.permissions.fs.write.allow` 复核；`cell-server` 写模板 `actionType`；装配器做治理语义校验与 record-only 归一。
6. **证据**：真进程 fixture `tests/fixtures/file-write-plugin/` + `tests/native-file-write-aop.test.ts` A1/A2/A3；cell/host 单测覆盖 G1~G8、计划编译、内置补偿成功/拒绝/无基线/相对路径/混合候选。
7. **文档收尾**：phase-3 合同、00-roadmap、docs/README、glossary、两份 README 待决表、CHANGELOG 0.1.045、CONTEXT、本 handoff、新增 P-014。

## 验证（2026-11-03）

- `pnpm format:check` ✅ / `pnpm lint` ✅ / `pnpm typecheck` ✅ / `pnpm build` ✅
- `pnpm test` ✅：**46 文件 376 测试**（含新增 AOP 8 + host 治理 3 + builtin 5 + 真进程 3）
- `bash scripts/check-size` ✅：docs 53/150、.agents 23/40、构建产物 675KB
- 未提交 git（工作区改动待所有者决定）

## 关键决策与边界

- AOP 不是沙箱；真正边界 = Cell 隔离 + manifest 授权 + 评审。
- `fs.remove` 只适合“本次新建的单文件”；覆盖写走 record-only 或插件补偿；网络无通用撤销。
- 保守声明：handler 前声明，业务失败也可能有条目；补偿必须容忍目标不存在（T06）。
- 工具级 retry 会重新声明 effect（新 effectId）；跨 attempt 幂等另案（toolCallId）。
- D5：装配器暂不强制边界能力必须有 governance；原生插件由 REVIEW 强制，切片⑤复评。

## 遗留与下一步

- **切片④**：写 `docs/design/phase-3/07-*.md` → 插件 B（file-write 转正，纯 handler + builtin，补 C3“未声明写当场拒绝、零部分生效”）+ 插件 C（param-guard，C4）；REVIEW.md 留痕 + 禁面扫描。
- **切片⑤**：manifest 回填复核、C1~C7 逐条复核、Phase 3 report、基准复采、阶段 tag（归所有者）。
- 未做（明确不在切片③）：`fs.restore`、递归删除、net 内建、嵌套字段/JSONPath、条件声明。

## 已提取的沉淀

- **P-014**：自研 Schema 子集把“动态键映射”当成已支持 → 改为数组 + 装配器语义校验，并让校验器明确拒绝对象形态 `additionalProperties`。
