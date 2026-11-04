/**
 * Profile 结构校验（Phase 4 切片②，01 稿 P4 第 2 步）：
 * 与 manifest 五步校验同一层分工——Schema 管形状（未知字段拒绝），装配器管语义。
 * 校验器与关键词集合完全复用 `schema-validator`（零新增依赖）。
 */

import { validateSchema, type SchemaIssue } from "../schema-validator.js";

export function validateProfileDocument(schema: unknown, raw: unknown): SchemaIssue[] {
  return validateSchema(schema, raw);
}
