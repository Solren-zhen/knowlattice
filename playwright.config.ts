/**
 * 真实浏览器端到端测试（Playwright）。
 *
 * 为什么必须有这一层：jsdom 没有布局引擎、没有真实的 IndexedDB 与 CodeMirror 输入管线，
 * 而本项目历史上栽过的坑恰好都在那一侧——「单测绿、真浏览器里丢」：
 *   - setState updater 返回同一引用时真浏览器跳过，jsdom 却会执行（副作用写进 updater 就漂移）；
 *   - setPointerCapture 的 pointerId 校验在合成事件里根本不会触发；
 *   - 刷新后 IndexedDB 里的数据是否真的落盘，只有真浏览器能回答。
 *
 * 只跑冒烟：打开 → 新建笔记 → 输入 → 刷新后内容还在 → 切换整屏面板。
 * 不做交互细节断言（那些归 DOM 测试），否则会变成第二个慢而脆的测试套件。
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5175);

export default defineConfig({
  testDir: './e2e',
  // 单文件串行：每个 test 一个全新 browser context（独立 IndexedDB），互不污染
  fullyParallel: true,
  workers: process.env.CI ? 2 : 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // 本机 shell 里常带 CI=true（实测），用它来开关复用会在本地误判；CI 上本来也没服务在跑，直接复用无害
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
