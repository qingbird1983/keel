# H-037 切片④ engine kind 收口

- 日期：2026-11-04
- 主题：Phase 4 切片④——`kind:"engine"` 端到端（锚 D3/D5，复核 D1~D7）

## 本轮做了什么

1. **契约修订 R6/R7/R8 落地**（清单 R1~R13 全部关闭）：
   - Cell 受理面新增 `engine.step`；报关单 `engine` 段随 bootstrap 送达；宿主
     `SupervisedCell.stepEngine()` 走既有 `call`，一步时限 = 契约 300s 档。
   - 错误码零新增：`ENGINE_PROTOCOL` / `ENGINE_EXITED` / `MAX_STEPS` 都是载荷级 reasonCode。
2. **Core 侧**：
   - `surface.ts` 新增纯投影 `projectSurface`（白名单 + 版本号）；`TOOL_RESULT` 追加 `toolCallId`。
   - `scheduler.ts`：`RunManifest.turnInput`（`TURN_INPUT` 由调度器写）、`DriverDecision.basedOn`
     （模型直写事件进归因）、`haltReason`（`MAX_STEPS` → `RUN_HALTED{reasonCode}`）、
     tool 动作接受决策方 `toolCallId`、异常 catch 接受带 code 的结构化错误。
3. **Host 侧**：
   - `engine-driver.ts`：`EngineDriver`（投影 → `engine.step` → 封闭形状校验 → 写 `MODEL_MESSAGE`
     → 返回 `DriverDecision`）；失败映射（舱退出 / 收尾拒新 / 超时 / 预算 / 上游错误）。
   - `profile/assemble.ts` 暴露 `engine`（cell + decl）；`compensator.readPermissions` 修正 P-022。
4. **插件**：`packages/plugins/engine-react`（零依赖 ReAct 标杆 + REVIEW + 单测）；
   `model-mock` 增加 ReAct 剧本（按用户输入计划确定性扮演模型）。
5. **交付入口**：`keel run --profile` 接引擎驱动（`--input` 起始输入）；runtime 把 engine 舱退出
   映射为 `ENGINE_EXITED`。
6. **文档**：03 稿 §10、04 稿切片④注记、phase-4/report.md、看板、CHANGELOG 0.1.057、docs/README。

## 验证

- 六道门禁全绿：format / lint / typecheck+build / test **64 文件 485 测试** / 扫描实扫零命中。
- D3-a：模型→工具→模型→终结；表面事件、`MODEL_USAGE`（manifest 计价）、`toolCallId` 对齐。
- D3-b：file-write 真写盘 + 收据 + 只读账本补偿删除。
- D3-c：kill 引擎舱 → `RUN_FAILED{ENGINE_EXITED}`、在途模型收束、并行 run halted、补偿回放。
- D5：每步 `DECISION.basedOn` 含本步 `MODEL_USAGE` 与上一步 `TOOL_RESULT`；投影重算一致。
- D2：超预算下一跳被拒、`RUN_FAILED{BUDGET/EXHAUSTED}`、无未落账调用。
- 协议封闭：未知字段 / 未声明工具 / 超 `maxSteps` 各一例。
- CLI：`run --profile react-loop`（4 插件全家桶）经引擎驱动收束。

## 遗留与下一步

- `model-deepseek` 真实请求仍无密钥、未执行（不进 CI 的口径不变）。
- `phase-4.end` tag 与 `docs/phase4-charter` merge 时机归所有者。
- 根 `tests/` 类型检查缺口（既有）未变；后续阶段候选见 backlog。

## 已提取的沉淀

- P-022：装配记录逐插件化后补偿只读第一条（本轮发现并修复）。
- P-020 延伸注记：同宿主多 profile 的模型名全局重绑（测试须用同一份 model 声明）。
