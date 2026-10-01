import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'apps/web/e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    screenshot: 'only-on-failure',
    // Reuse an already-installed Chromium instead of downloading (CI leaves this unset).
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : undefined,
  },
  outputDir: 'test-results',
  // One login per test: refresh tokens rotate (a shared saved session would trip reuse detection).
  // Five logins stay under the 10/min login limit — don't probe /auth/login before running.
});
