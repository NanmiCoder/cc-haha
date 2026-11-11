import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from '../../shared/__fixtures__/remote-identity-v2.json'
import { startSelfHostedDirectory } from './selfHostedMain'

test('serves the private directory only on loopback with HTTP body bounds and clean shutdown', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cc-haha-directory-listener-test-'))
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  const app = startSelfHostedDirectory({
    CC_HAHA_DIRECTORY_STATE_DIR: stateDir,
    CC_HAHA_DIRECTORY_PORT: String(port),
    CC_HAHA_DIRECTORY_ALLOWED_HOST_IDS: fixture.hostId,
  })
  try {
    expect(app.server.hostname).toBe('127.0.0.1')
    const endpoint = `http://127.0.0.1:${port}`
    expect((await (await fetch(`${endpoint}/health`)).json()).access).toBe('private')
    expect((await fetch(`${endpoint}/v1/hosts/${'a'.repeat(64)}`)).status).toBe(403)
    expect((await fetch(`${endpoint}/v1/hosts/${fixture.hostId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(4097),
    })).status).toBe(413)
  } finally {
    await app.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
