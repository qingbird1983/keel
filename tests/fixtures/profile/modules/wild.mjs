/**
 * 未声明插件探针（Phase 4 切片② P5）：
 * 放在 profile 目录里但**没有任何 profile 条目引用它**；一旦被 import 即留下全局痕迹。
 */

globalThis.__keelWildModuleLoads = (globalThis.__keelWildModuleLoads ?? 0) + 1;

export const tools = [];
