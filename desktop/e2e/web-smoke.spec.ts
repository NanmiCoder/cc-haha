import { test, expect } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

test('SPA loads without Tauri console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  await page.goto('/')
  await expect(page.locator('#root')).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(errors.filter((e) => /tauri/i.test(e))).toEqual([])
})

test('creating a session materializes workspaces/<sid>', async ({ request }) => {
  const res = await request.post('/api/sessions', { data: {} })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { sessionId: string }
  expect(body.sessionId).toBeTruthy()

  const wsDir = path.resolve(here, '..', '..', 'workspaces', body.sessionId)
  const stat = await fs.stat(wsDir)
  expect(stat.isDirectory()).toBe(true)

  // cleanup
  await fs.rm(wsDir, { recursive: true, force: true })
})

test('health endpoint returns ok', async ({ request }) => {
  const res = await request.get('/health')
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { status: string }
  expect(body.status).toBe('ok')
})
