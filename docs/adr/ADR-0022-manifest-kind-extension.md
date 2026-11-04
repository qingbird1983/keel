# ADR-0022：manifest 扩展两个 kind（`model` / `engine`）

- 状态：定稿（2026-11-04，随 [Phase 4 切片①设计稿 01~04](../design/phase-4/01-profile-assembly.md) 所有者过闸）
- 日期：2026-11-04
- 关联：[phase-4 合同](../roadmap/phase-4-profile-engine-loop.md) §4/§8 K1/K6；[manifest 规范](../design/phase-1/03-plugin-manifest.md) §5/§6；[schema](../design/phase-1/schema/keel-plugin.schema.json)；[01 稿](../design/phase-4/01-profile-assembly.md)（装配与隔离分派）；[02 稿](../design/phase-4/02-model-kind.md)（model 段）；[03 稿](../design/phase-4/03-engine-kind.md)（engine 段）；[research/02](../research/02-deepseek-api-survey.md)（计价与模型现状）
- 取代：无（既有三 kind 的规则一条不改）

## 背景

manifest 的 `kind` 今天是封闭三值：`capability` / `policy` / `observation`（`schema:11-14`；`assembler.ts:16-17`）。Phase 4 要长出的两类插件与既有三类的**运行环境、生命周期、持密能力**都不同：

- `model` 跑在宿主进程内（必须持密钥、要出网），不是 Cell；
- `engine` 跑在 Cell，但它是"决策者"而非"工具提供者"，权限面应当比 capability 更窄。

把两者塞进 `capability` 会让"运行环境由 kind 决定"这条装配规则失效——那正是本项目与 DSH 的核心差别（合同 §1）。

## 决策

1. **`kind.enum` 扩为五值**：`capability` / `policy` / `observation` / `model` / `engine`；`additionalProperties:false` 不变。
2. **新增两段条件必填**（Schema `if/then`）：`kind:"model"` 必须带 `model` 段；`kind:"engine"` 必须带 `engine` 段；其余三类出现这两段即拒绝。
3. **`model` 段**（形状与语义见 02 稿 §4）：`provider`、`protocol`（`http-sse`/`mock`）、`models`、`endpoint`（http-sse 必填）、`auth.ref`（环境变量名，非明文）、`pricing`（按模型分表：三桶 + 谷/峰两档 + 峰时窗口）、`timeouts.idleMs`（可选，≤ 契约总时限）。**价格是声明，不是自报**：Core 按表计价（02 稿 M3）。
4. **`engine` 段**：`loop`（首版仅 `react`）、`model.ref` + `model.name`（必须命中 profile 内的 model 插件）、`tools`（非空；每个名字装配期**恰好一个**能力插件提供，重名整份拒绝）、`maxSteps`（1~100）。
5. **能力词表不增项**：`engine` 的 `permissions` 只允许 `model.adapter`，越界即整份拒绝（语义校验在装配器，Schema 管形状）；`model` 不产出 Cell 侧能力规则。
6. **五步校验零豁免**：新 kind 与老三类走同一 `Assembler.assemble`（结构 → 权限交叉 → 资源 → 版本 → 记录）；新增的领域语义校验（价格表键集合 = `models`、`peak` 存在时 `peakWindows` 必填、`auth.ref` presence-only、`engine.tools` 唯一命中、`maxSteps` 区间）作为第 1 步补充，与 ADR-0015 的治理校验并列。
7. **profile 与 manifest 的 kind 必须一致**（01 稿 P3）：profile 声明 `kind:"model"` 而报关单是 `capability` → 整份拒绝，不得从任一侧"推断"。

## 理由

- 运行环境由 kind 决定，是装配面唯一稳定的分派依据；`model` 与 `engine` 的环境差异（Host vs Cell、持密钥 vs 禁密钥）**结构上不可互换**。
- 不新增能力词：词表封闭是既有纪律（manifest 稿 §5.2），engine 需要的"调模型"已有 `model.adapter`，"能请求哪些工具"用 `engine.tools` 白名单表达，不必发明 `tool.call`。
- 价格进 manifest 而非代码：同一适配器可服务多 provider/多模型，价格随清单版本化；也避免"价格改一次、发一次包"。

## 后果

- 积极：五类插件共用一条装配/校验/审计链；隔离分派表（01 稿 P7）成为唯一事实；model 的密钥与价格都可静态审查。
- 代价 / 风险：`model` 段带价格与窗口，声明面变大——用 Schema 严格约束 + 装配器语义校验兜住；provider 价格变动需改清单（可在 profile 覆盖？**本阶段不做**，记 backlog）。
- 重评条件：出现第三种运行环境（如 ui 沙箱）时，把"kind → 环境"从代码表提升为正式映射表（届时另立 ADR）。
- **被否方案**：A 塞进 `capability`（引擎/模型会继承补偿与工具语义，环境分派失效）；B 新增 `tool.call` 能力（词表扩张且与 `engine.tools` 重复）；C 让 manifest 引用外部价格文件（多一个可被篡改的事实来源，且违反"清单自包含"）。
