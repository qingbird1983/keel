// ESLint 平面配置（standards/04 §1：error 级挂门禁，命令固定 `pnpm lint`）
// TODO(phase-1 切片): 首批含异步/IO 的实现落地时切换 recommendedTypeChecked + projectService（类型感知规则）。
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      // 真样本第三方源码树（B5 义务材料）：他方代码不入库（见该目录 SOURCES.md §3），
      // 在本地工作区里也不跟我们的门禁——`pnpm lint` 实测在三枚上报 82 个 error（`no-undef` 缺 Node 全局、
      // `_error` 未用…）。要过只能改他方代码，违反 02 稿 §7 判据 1/2（存量样本只读），故长期排除。
      // 注意：eslint 不读 .gitignore，所以这条 ignore 与 .gitignore 里那三条**必须同时存在**。
      "tests/fixtures/cordis-plugins/real-samples/**",
    ],
  },
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
  {
    // A 档合成样本（tests/fixtures/cordis-plugins/**.cjs）：旧框架书写习惯 = CommonJS。
    // 这些文件是"存量插件代码"的替身，禁止为迁就新内核而改写（02 稿 §7 判据 1/2），
    // 所以这里只声明宿主全局与模块形态，不给它们加任何 Keel 侧约定。
    files: ["tests/fixtures/cordis-plugins/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        console: "readonly",
        process: "readonly",
        setImmediate: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        globalThis: "readonly",
        Object: "readonly",
        Array: "readonly",
        Date: "readonly",
        Error: "readonly",
        Promise: "readonly",
        undefined: "readonly",
      },
    },
    rules: {
      // 样本刻意包含"被测的旧写法"本身：原型链补丁、require 加载、吞异常的 catch 都是观察对象，
      // 不是待修的代码问题。关掉这几条风格规则 = 把这批文件当外部素材对待，
      // 不给它们加 Keel 侧约定（判据 3：承接层不改写样本源码，也不要求它符合我们的 lint）。
      "no-extend-native": "off",
      "@typescript-eslint/no-require-imports": "off",
      // 只有 catch 形参豁免（旧代码 `catch (e) {}` 就地吞掉是 #10 的被测行为）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
