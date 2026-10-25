import '../../../preload.ts'
import { afterEach, expect, test } from 'bun:test'
import { ensureStandaloneProviderProxy, stopStandaloneProviderProxyForTests } from './standaloneProviderProxy.js'
import { runCleanupFunctions } from '../../utils/cleanupRegistry.js'

afterEach(() => stopStandaloneProviderProxyForTests())

test('reuses the standalone listener and stops it during graceful shutdown', async () => {
  const port = ensureStandaloneProviderProxy()
  const endpoint = `http://127.0.0.1:${port}/health`
  expect(ensureStandaloneProviderProxy()).toBe(port)
  expect((await fetch(endpoint)).status).toBe(200)

  await runCleanupFunctions()

  await expect(fetch(endpoint)).rejects.toThrow()
})
