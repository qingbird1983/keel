// ESLint 平面配置（standards/04 §1：error 级挂门禁，命令固定 `pnpm lint`）
// TODO(phase-1 切片): 首批含异步/IO 的实现落地时切换 recommendedTypeChecked + projectService（类型感知规则）。
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // 未使用参数多为占位接口签名，下划线前缀显式豁免
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // TS 文件由类型系统负责未定义检查，no-undef 会误报（typescript-eslint 官方建议关闭）
    files: ["**/*.ts"],
    rules: { "no-undef": "off" },
  },
  {
    // Node 维护脚本（scripts/*.mjs）：声明用到的宿主全局
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    // 集成测试 fixture 插件（tests/fixtures/*.mjs）：声明用到的宿主全局
    files: ["tests/fixtures/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
