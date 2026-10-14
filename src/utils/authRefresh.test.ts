import { describe, expect, test } from 'bun:test'
import { refreshAwsAuth, refreshGcpAuth } from './auth.js'

// The refresh commands are user-configured shell snippets; run harmless ones
// through the real exec path so success and failure both resolve.
describe.skipIf(process.platform === 'win32')('cloud auth refresh commands', () => {
  test('AWS refresh resolves true when the command succeeds', async () => {
    await expect(refreshAwsAuth('echo aws-signed-in')).resolves.toBe(true)
  })

  test('AWS refresh resolves false when the command fails', async () => {
    await expect(refreshAwsAuth('echo aws-denied >&2; exit 3')).resolves.toBe(false)
  })

  test('GCP refresh resolves true when the command succeeds', async () => {
    await expect(refreshGcpAuth('echo gcp-signed-in')).resolves.toBe(true)
  })

  test('GCP refresh resolves false when the command fails', async () => {
    await expect(refreshGcpAuth('exit 4')).resolves.toBe(false)
  })
})
