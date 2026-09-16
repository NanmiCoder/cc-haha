import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { remoteProviderRouteAllowed, remoteSettingsRouteAllowed, validateRemoteSettingsPatch } from './remoteBrowserPolicy.js'

test('remote settings boundary permits only intended provider routes and General fields', () => {
  const parts = (pathname: string) => pathname.split('/').filter(Boolean)
  expect(remoteProviderRouteAllowed(parts('/api//providers/settings/'), 'GET')).toBe(false)
  expect(remoteProviderRouteAllowed(parts('/api/providers/id/extra'), 'DELETE')).toBe(false)
  expect(remoteProviderRouteAllowed(parts('/api/providers/id/activate'), 'POST')).toBe(true)
  expect(remoteSettingsRouteAllowed(parts('/api/settings/user/extra'), 'PUT')).toBe(false)
  expect(validateRemoteSettingsPatch({ hooks: {} })).toBe(false)
  expect(validateRemoteSettingsPatch({ alwaysThinkingEnabled: 'true' })).toBe(false)
  expect(validateRemoteSettingsPatch({ chatSendBehavior: 'modifierEnter' })).toBe(true)
  expect(validateRemoteSettingsPatch({ language: '' })).toBe(true)
})

test('LAN and public provider CRUD redact and preserve keys; General edits isolate desktop secrets', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'remote-settings-integration-'))
  try {
    const child = Bun.spawn([process.execPath, '--no-env-file', path.join(import.meta.dir, '__fixtures__/remoteBrowserSettingsSmoke.ts')], {
      env: createSandboxedTestEnvironment(home, { CC_HAHA_LOCAL_ACCESS_TOKEN: 'fixture-process-credential' }), stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect({ exitCode, output: exitCode === 0 ? '' : `${stdout}\n${stderr}` }).toEqual({ exitCode: 0, output: '' })
      expect(stdout).toContain('REMOTE_SETTINGS_INTEGRATION_PASSED')
    } finally { clearTimeout(timeout); child.kill() }
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 20_000)
