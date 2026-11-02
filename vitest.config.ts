// Vitest 根配置：单元测试在各包 test/ 目录（standards/05 §1，实现/测试分离），跨包集成测试集中 tests/（Phase 1 按需建立）
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 构建的唯一执行点：主进程跑一次，避免 41 个 worker 并发 `pnpm build` 抢 dist/（见该文件注释）
    globalSetup: ["./tests/fixtures/global-setup.ts"],
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
