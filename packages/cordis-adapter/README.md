# @keel/cordis-adapter（已归档）

> **状态：归档 / 实验性（2026-11-03，[ADR-0014](../../docs/adr/ADR-0014-drop-legacy-ecosystem-compat.md)）**
> 全面兼容 DSH 旧生态的决定已终止：本包不再接受新的兼容面（不加映射、不修旧缺陷、不接新样本）。
> **保留不删的理由**：本包的测试是内核通道能力（运行期注册 / 装载门 / 策略 hook / `model.stream` / 快照 / drain）**唯一的真进程证据链**，删除即销毁证据。这些内核能力已转供 Phase 3 原生插件生态使用。
> 是否将本包（及其测试）移出主门禁，随 Phase 3 合同评审后另行决定（ADR-0014 明确不在当期处置）。

---

Cordis 存量插件生态的兼容适配原型：验证"旧插件不改代码迁入 Keel"的迁移路径是否可行。**结论（2026-11-03，真样本第一批）：不可行**——三枚真实第三方插件无一进入承接层（入口形状 / 按 npm 名 import 宿主包），12 类旧形状面在边界表无归属；发现已转存为 Phase 3 评审反面教材（[design/phase-3/01](../../docs/design/phase-3/01-legacy-anti-patterns.md)）。

## 历史定位（Phase 2，已提前收口）

- **有损兼容，边界显式化**：Cordis 的共享 Context、全局注册表等语义不能原样保留；适配器把旧 API 映射到 Keel 的受控等价物，映射不到的语义显式报错而非静默降级
- 承接面：A 档直用 / B 档补声明 / C 档改写（`ctx.model.invoke` / `ctx.effects.declare` / `ctx.ledger.read`）/ D 档硬拒（零例外）
- 口径：[phase-2 合同](../../docs/roadmap/phase-2-cordis-compat.md)（**已提前收口**，§8 为终止处置表）+ 六份设计稿（冻结留痕）

## 目录与运行（仅作证据链复跑）

```text
src/    实现（冻结）
test/   单元测试（与 src/ 一一对应镜像；含内核通道 op 的真进程测试）
```

```bash
pnpm --filter @keel/cordis-adapter typecheck
pnpm --filter @keel/cordis-adapter build
pnpm test   # 全仓测试（根目录执行；本包测试仍在门禁内，归 Phase 3 复核）
```

## 关联文档

- 战略决定：[ADR-0014](../../docs/adr/ADR-0014-drop-legacy-ecosystem-compat.md)
- 反面教材：[design/phase-3/01](../../docs/design/phase-3/01-legacy-anti-patterns.md)
- 架构：[docs/architecture/01-keel-overview.md](../../docs/architecture/01-keel-overview.md) §7
