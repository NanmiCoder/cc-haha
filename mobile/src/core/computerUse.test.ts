import { expect, test } from 'bun:test'
import type { ApiClient } from './client'
import { loadComposerComputerUse, needsComputerPermission, setComposerComputerUse } from './computerUse'

test('Computer Use reads global state without mutating it before consent', async () => {
  const gets: string[] = []
  let writes = 0
  const client = { get: async (path: string) => {
    gets.push(path)
    return path.endsWith('/status') ? { supported: true, engine: 'macos-native', permissions: { accessibility: false, screenRecording: true } } : { enabled: false }
  }, request: async () => { writes++ } } as unknown as ApiClient
  const status = await loadComposerComputerUse(client, new AbortController().signal)
  expect(gets).toEqual(['/api/computer-use/status', '/api/computer-use/authorized-apps'])
  expect(status.enabled).toBe(false)
  expect(needsComputerPermission(status)).toBe(true)
  expect(writes).toBe(0)
})
test('consented enable uses desktop global grants and disable preserves all other configuration', async () => {
  const requests: unknown[] = []
  const client = { request: async (...args: unknown[]) => { requests.push(args) } } as unknown as ApiClient
  await setComposerComputerUse(client, true)
  await setComposerComputerUse(client, false)
  expect(requests).toEqual([
    ['/api/computer-use/authorized-apps', { method: 'PUT', body: { enabled: true, grantFlags: { clipboardRead: true, clipboardWrite: true, systemKeyCombos: true } } }],
    ['/api/computer-use/authorized-apps', { method: 'PUT', body: { enabled: false } }],
  ])
})
test('failed global mutation is surfaced instead of treated as enabled', async () => {
  const client = { request: async () => { throw new Error('fixture write failed') } } as unknown as ApiClient
  await expect(setComposerComputerUse(client, true)).rejects.toThrow('fixture write failed')
})

test('an already-enabled computer with missing OS grants still requires the permission card', () => {
  expect(needsComputerPermission({ supported: true, enabled: true, engine: 'macos-native', permissions: { accessibility: true, screenRecording: false } })).toBe(true)
})
test('permission card uses the desktop ten-minute timeout and refreshes actual permissions after closing', async () => {
  const { openComputerPermissionCard } = await import('./computerUse')
  const signal = new AbortController().signal
  const calls: unknown[] = []
  const client = {
    request: async (...args: unknown[]) => { calls.push(args) },
    get: async (path: string) => { calls.push(path); return path.endsWith('/status') ? { supported: true, engine: 'macos-native', permissions: { accessibility: true, screenRecording: true } } : { enabled: true } },
  } as unknown as ApiClient
  const value = await openComputerPermissionCard(client, signal)
  expect(calls[0]).toEqual(['/api/computer-use/open-permission-card', { method: 'POST', timeoutMs: 600000, signal }])
  expect(calls.slice(1)).toEqual(['/api/computer-use/status', '/api/computer-use/authorized-apps'])
  expect(needsComputerPermission(value)).toBe(false)
})
