// Playwright 配置：同时在「原版 :3000」与「Worker :8787」跑同一套用例。
// 本地先起两端（见 BASELINE.md §1），然后：
//   ORIGIN=http://localhost:3000 WORKER=http://localhost:8787 npm run e2e
import { defineConfig, devices } from '@playwright/test';

const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';
const WORKER = process.env.WORKER || 'http://localhost:8787';

// 两个 project 分别指向两端；同一份 spec 跑两遍即为「同一前端、两套后端」对比
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'e2e-report', open: 'never' }]],
  use: {
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'origin', use: { ...devices['Desktop Chrome'], baseURL: ORIGIN } },
    { name: 'worker', use: { ...devices['Desktop Chrome'], baseURL: WORKER } },
  ],
});
