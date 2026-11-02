/**
 * JSON Schema（draft 2020-12）关键词子集校验器 —— manifest 稿 §7（C-M2 分层的结构校验层）。
 *
 * 封闭关键词集合 = keel-plugin.schema.json 的实际使用者：
 * type / required / properties / additionalProperties(false) / enum / const / pattern /
 * minLength / maxLength / minimum / maximum / minItems / maxItems / maxProperties /
 * items / allOf / if / then。
 * Schema 是仓库第一方产物（docs/design/phase-1/schema/），关键词集随 Schema 修订同步维护；
 * 新关键词出现 = Schema 语义级变更，须先扩本表（校验器拒绝未知关键词，防静默漏检）。
 * 零运行时依赖（所有者已确认，不引入 ajv）。
 */

export interface SchemaIssue {
  /** 实例路径（JSON Pointer 风格，如 /resources/toolCallTimeoutMs）。 */
  path: string;
  message: string;
}

/** 支持的关键词封闭集合；Schema 出现集合外关键词 = 结构性漏检风险，直接报错。 */
const SUPPORTED = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "maxProperties",
  "items",
  "allOf",
  "if",
  "then",
]);

/** draft 2020-12 注解关键词（§7.1）：非约束，跳过；Schema 新增注解时在此登记。 */
const ANNOTATIONS = new Set(["title", "description"]);

export function validateSchema(schema: unknown, value: unknown, path = ""): SchemaIssue[] {
  if (schema === true) return [];
  if (schema === false) {
    return [{ path, message: "schema forbids any value" }];
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return [{ path, message: "invalid schema node (must be object or boolean)" }];
  }
  const s = schema as Record<string, unknown>;
  const unknownKeys = Object.keys(s).filter(
    (k) => !SUPPORTED.has(k) && !ANNOTATIONS.has(k) && !k.startsWith("$"),
  );
  if (unknownKeys.length > 0) {
    return [{ path, message: `unsupported schema keywords: ${unknownKeys.join(", ")}` }];
  }
  const issues: SchemaIssue[] = [];
  const fail = (p: string, message: string) => issues.push({ path: p, message });

  if (s.type !== undefined && !checkType(s.type as string, value)) {
    fail(path, `expected type ${s.type}`);
    return issues; // 类型不符时不再做值级比较
  }

  if (s.const !== undefined && !deepEqual(value, s.const)) {
    fail(path, `expected const ${JSON.stringify(s.const)}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(value, v))) {
    fail(path, `expected one of ${s.enum.map((v) => JSON.stringify(v)).join(" | ")}`);
  }
  if (
    typeof s.pattern === "string" &&
    typeof value === "string" &&
    !new RegExp(s.pattern).test(value)
  ) {
    fail(path, `does not match pattern ${s.pattern}`);
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) {
      fail(path, `shorter than minLength ${s.minLength}`);
    }
    if (typeof s.maxLength === "number" && value.length > s.maxLength) {
      fail(path, `longer than maxLength ${s.maxLength}`);
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum)
      fail(path, `below minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum)
      fail(path, `above maximum ${s.maximum}`);
  }

  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) issues.push(...validateSchema(sub, value, path));
  }
  // draft 2020-12：if 通过（无 issue）才施加 then；else 未在本集合（Schema 未使用）
  if (s.if !== undefined && s.then !== undefined) {
    if (validateSchema(s.if, value, path).length === 0) {
      issues.push(...validateSchema(s.then, value, path));
    }
  }

  if (isObject(value)) {
    const obj = value as Record<string, unknown>;
    const props = (isObject(s.properties) ? s.properties : {}) as Record<string, unknown>;
    for (const key of (s.required as unknown[]) ?? []) {
      if (typeof key === "string" && !(key in obj))
        fail(path, `missing required property "${key}"`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) issues.push(...validateSchema(sub, obj[key], `${path}/${key}`));
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props) && key !== "$schema") {
          fail(`${path}/${key}`, `unexpected additional property "${key}"`);
        }
      }
    }
    if (typeof s.maxProperties === "number" && Object.keys(obj).length > s.maxProperties) {
      fail(path, `more than maxProperties ${s.maxProperties}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      fail(path, `fewer than minItems ${s.minItems}`);
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      fail(path, `more than maxItems ${s.maxItems}`);
    }
    if (s.items !== undefined) {
      value.forEach((item, i) => issues.push(...validateSchema(s.items, item, `${path}/${i}`)));
    }
  }
  return issues;
}

function checkType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON 值深度相等（枚举/const 比较；键序无关）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every(
        (k) =>
          k in (b as object) &&
          deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}
