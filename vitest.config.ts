// Vitest 根配置：单元测试在各包 test/ 目录（standards/05 §1，实现/测试分离），跨包集成测试集中 tests/（Phase 1 按需建立）
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 构建的唯一执行点：主进程跑一次，避免 41 个 worker 并发 `pnpm build` 抢 dist/（见该文件注释）
    globalSetup: ["./tests/fixtures/global-setup.ts"],
    include: [
      "packages/*/test/**/*.test.ts",
      // 插件在 packages/plugins/<name>/（workspace 包）：单测同样进门禁（切片④修正——
      // 此前 echo 的包内单测因 glob 少一层而从未被收集，属于盲区）
      "packages/plugins/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    // Cordis 兼容层测试已剥离主线门禁（2026-11-03 所有者决定，ADR-0014 实施注记 3）：
    // 文件与断言保留在仓库（各文件头有归档横幅），可单独复跑；内核命名的测试（快照/流式/throughSeq/策略链）不在剥离范围。
    exclude: [
      ...configDefaults.exclude,
      "tests/cordis-*.test.ts",
      "packages/cordis-adapter/test/**/*.test.ts",
    ],
  },
});
