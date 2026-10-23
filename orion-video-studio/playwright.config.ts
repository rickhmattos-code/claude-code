import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

/**
 * Testes de interface contra a stack local em execução (web :3000, API :4000,
 * worker, Postgres, Redis) — veja README › Testes. O Chromium pré-instalado do
 * ambiente é usado quando presente (PW_CHROMIUM_PATH sobrescreve).
 */
const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(preinstalled) ? preinstalled : undefined)

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
