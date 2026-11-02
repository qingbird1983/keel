# H-007-manifest修复清单落实

- 日期：2026-11-02
- 范围：Phase 0 任务 C 评审修复（manifest 三份文件）

## 本轮做了什么

1. 所有者下达分级修复清单（A 阻断/B 回填/C 结构缺口/D 小问题 + E 禁改清单），九项全部落实、零越界改动：
   - A1+D1 合并：$schema/$id 统一为 `https://keel.dev/schema/keel-plugin.schema.json`（占位 URI）
   - A2：capability 分支补 subscriptions maxItems 0
   - B1：§5.3 资源上限表（600000/4096/1000，来源待所有者确认）+ §11 待决行
   - C1：policy/observation 分支补 resources maxProperties 0 + §4 表备注空对象
   - C2：observation 分支补 compensation.templates maxItems 0
   - C3：§5.2 末补 allow 必填性分层说明（C-M2）
   - D2：meta.version 描述补 build metadata 禁用说明（未改 pattern）
   - D3：§5.5 补迁移钩执行链路（结构化通道/新 Cell 内/结果入账本/不访问旧 Cell 与外网）
   - 连带一致性：§7 $id 描述从"本仓路径语义"改为占位 URI（D1 引起，已报告）
2. 实测：schema 合法、两示例 PASS、负路径探针 2/2 拦截生效（capability+subscriptions、policy+resources）
3. CHANGELOG 0.1.008 登记

## 验证

- python jsonschema 4.26（-I）：7 项检查全过（见 H-007 执行记录）

## 遗留与下一步

- 待所有者确认 → C 转定稿
- 新问题登记（未改，见报告）：policy 的 templates 未约束、$id 域名归属、装配事件缺位（01 §5）、migration 对 policy/observation 无意义未禁、manifest 自身 schemaVersion 待决
- 三个资源上限数值待所有者确认（不阻塞定稿）

## 已提取的沉淀

- 所有者修复清单模式（分级+禁改清单+逐项报告）效果很好——结构化评审可直接转执行
