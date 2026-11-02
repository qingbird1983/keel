// Vitest 根配置：单元测试随源码（standards/05 §1），跨包集成测试集中 tests/（Phase 1 按需建立）
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
