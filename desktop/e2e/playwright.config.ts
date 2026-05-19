import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: here,
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3458',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
  ],
  webServer: {
    command: 'bun run start:web',
    cwd: path.resolve(here, '..', '..'),
    url: 'http://127.0.0.1:3458/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      CC_HAHA_RUNTIME: 'web',
      CLAUDE_H5_DIST_DIR: path.resolve(here, '..', 'dist-web'),
      SERVER_PORT: '3458',
    },
  },
  globalSetup: fileURLToPath(new URL('./global-setup.ts', import.meta.url)),
})
