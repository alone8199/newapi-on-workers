import { defineConfig } from 'vitest/config';

// 单元/契约测试只跑 tests/；e2e/*.spec.ts 属于 Playwright，交给 `npm run e2e`。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
