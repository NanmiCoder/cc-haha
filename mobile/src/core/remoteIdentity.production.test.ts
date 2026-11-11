import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../../scripts/pr/test-environment'

test('Expo v2 pairing, signed discovery, restart recovery and revocation agree with the production server', () => {
  const home = mkdtempSync(join(tmpdir(), 'expo-identity-contract-'))
  try {
    const result = spawnSync(process.execPath, ['--no-env-file', '--preload',
      new URL('../../../preload.ts', import.meta.url).pathname,
      new URL('./__fixtures__/remoteIdentityContract.ts', import.meta.url).pathname], {
      cwd: home, encoding: 'utf8', timeout: 20_000,
      env: { ...createSandboxedTestEnvironment(home), NODE_ENV: 'test', MOBILE_IDENTITY_SANDBOX: home },
    })
    if (result.status !== 0) throw new Error(`Identity contract failed: ${result.stderr}\n${result.stdout}`)
    expect(result.stdout).toContain('mobile identity production contract passed')
  } finally { removeTestSandbox(home, 'mobile identity contract') }
}, 25_000)
