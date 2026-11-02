# @keel/cordis-adapter

Cordis 存量插件生态的兼容适配原型：验证"旧插件不改代码迁入 Keel"的迁移路径是否可行。

## 定位

- **有损兼容，边界显式化**：Cordis 的共享 Context、全局注册表等语义不能原样保留；本适配器把旧 API 映射到 Keel 的受控等价物，映射不到的语义显式报错而非静默降级

- **本阶段仅接口级原型**：`ctx.tools.register()` → scope 注册的最小映射——证明迁移方向可行即可

- **全量语义迁移在 Phase 2**（见 [roadmap](../../docs/roadmap/00-roadmap.md)）：承接存量插件全量语义前须先产出显式迁移边界文档

## 映射表（原型范围）

| Cordis 旧模式          | Keel 受控等价物                          |
| ---------------------- | ---------------------------------------- |
| `ctx.tools.register()` | scope 工具表注册（经装配器，非全局注册） |
| 共享 Context           | 只读注入 + 显式能力申请                  |
| effect 回收            | 补偿声明（`EFFECT_DECLARED`）            |

## 当前状态

✅ **接口级原型已落地（2026-11-02，Phase 1 阶段验收轮）**——`createCordisCtx({ctx, ref})` 提供 `tools.register/remove/list`，映射不到的旧语义显式报错。口径与有损边界清单见 [design/phase-1/05](../../docs/design/phase-1/05-cordis-adapter-prototype.md)；全量语义承接仍在 Phase 2（须先产出显式迁移边界文档）。

## 目录与开发

```text
src/    实现
test/   单元测试（与 src/ 一一对应镜像）
```

```bash
pnpm --filter @keel/cordis-adapter typecheck
pnpm --filter @keel/cordis-adapter build
pnpm test   # 全仓测试（根目录执行）
```

## 关联文档

- 兼容与迁移：[docs/architecture/01-keel-overview.md](../../docs/architecture/01-keel-overview.md) §7
