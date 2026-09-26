import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { projectRemoteSettings, remoteProviderRouteAllowed, remoteSettingsRouteAllowed, validateRemoteSettingsPatch } from './remoteBrowserPolicy.js'

test('remote settings routes permit the General sub-page endpoints and only those', () => {
  const p = (pathname: string) => pathname.split('/').filter(Boolean)
  // /user keeps GET+PUT
  expect(remoteSettingsRouteAllowed(p('/api/settings/user'), 'GET')).toBe(true)
  expect(remoteSettingsRouteAllowed(p('/api/settings/user'), 'PUT')).toBe(true)
  expect(remoteSettingsRouteAllowed(p('/api/settings/user'), 'POST')).toBe(false)
  // output-style picker + transcript retention are reachable from H5 General
  expect(remoteSettingsRouteAllowed(p('/api/settings/output-styles'), 'GET')).toBe(true)
  expect(remoteSettingsRouteAllowed(p('/api/settings/output-style'), 'PUT')).toBe(true)
  expect(remoteSettingsRouteAllowed(p('/api/settings/session-cleanup'), 'POST')).toBe(true)
  // wrong method on the new sub-routes stays blocked
  expect(remoteSettingsRouteAllowed(p('/api/settings/output-styles'), 'PUT')).toBe(false)
  expect(remoteSettingsRouteAllowed(p('/api/settings/output-style'), 'GET')).toBe(false)
  expect(remoteSettingsRouteAllowed(p('/api/settings/session-cleanup'), 'GET')).toBe(false)
  // other General sub-routes stay desktop-only
  expect(remoteSettingsRouteAllowed(p('/api/settings/project'), 'GET')).toBe(false)
  expect(remoteSettingsRouteAllowed(p('/api/settings/cli-launcher'), 'GET')).toBe(false)
  expect(remoteSettingsRouteAllowed(p('/api/settings/output-style/extra'), 'PUT')).toBe(false)
})

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
  expect(validateRemoteSettingsPatch({ disableUpdates: true })).toBe(true)
  expect(validateRemoteSettingsPatch({ disableUpdates: 'true' })).toBe(false)
  expect(projectRemoteSettings({ disableUpdates: true })).toEqual({ disableUpdates: true })
})

test('General settings round-trip (H5 full GeneralSettings)', () => {
  // booleans the General UI writes
  expect(validateRemoteSettingsPatch({ agentTeamsEnabled: true })).toBe(true)
  expect(validateRemoteSettingsPatch({ autoDreamEnabled: false })).toBe(true)
  expect(validateRemoteSettingsPatch({ skipWebFetchPreflight: true })).toBe(true)
  expect(validateRemoteSettingsPatch({ desktopNotificationsEnabled: true })).toBe(true)
  expect(validateRemoteSettingsPatch({ agentTeamsEnabled: 'yes' })).toBe(false)
  // webSearch shape + mode enum
  expect(validateRemoteSettingsPatch({ webSearch: { mode: 'tavily', tavilyApiKey: 'k', braveApiKey: '' } })).toBe(true)
  expect(validateRemoteSettingsPatch({ webSearch: { mode: 'auto' } })).toBe(true)
  expect(validateRemoteSettingsPatch({ webSearch: { mode: 'bogus' } })).toBe(false)
  expect(validateRemoteSettingsPatch({ webSearch: { mode: 'tavily', tavilyApiKey: 3 } })).toBe(false)
  expect(validateRemoteSettingsPatch({ webSearch: 'tavily' })).toBe(false)
  // updateProxy / network shapes
  expect(validateRemoteSettingsPatch({ updateProxy: { mode: 'manual', url: 'http://p:1' } })).toBe(true)
  expect(validateRemoteSettingsPatch({ updateProxy: { mode: 'system', url: '' } })).toBe(true)
  expect(validateRemoteSettingsPatch({ updateProxy: { mode: 'x', url: '' } })).toBe(false)
  expect(validateRemoteSettingsPatch({ updateProxy: { mode: 'manual' } })).toBe(false)
  expect(validateRemoteSettingsPatch({ network: { aiRequestTimeoutMs: 60000, proxy: { mode: 'direct', url: '' } } })).toBe(true)
  expect(validateRemoteSettingsPatch({ network: { aiRequestTimeoutMs: 29999, proxy: { mode: 'manual', url: '' } } })).toBe(false)
  expect(validateRemoteSettingsPatch({ network: { aiRequestTimeoutMs: 60000, proxy: { mode: 'x', url: '' } } })).toBe(false)
  expect(validateRemoteSettingsPatch({ network: { aiRequestTimeoutMs: 60000 } })).toBe(false)
  // vccCompactBackend string enum
  expect(validateRemoteSettingsPatch({ vccCompactBackend: 'algorithm' })).toBe(true)
  expect(validateRemoteSettingsPatch({ vccCompactBackend: 'llm' })).toBe(true)
  expect(validateRemoteSettingsPatch({ vccCompactBackend: 'bogus' })).toBe(false)
  expect(validateRemoteSettingsPatch({ vccCompactBackend: 1 })).toBe(false)
  // cleanupPeriodDays integer [0,3650]
  expect(validateRemoteSettingsPatch({ cleanupPeriodDays: 30 })).toBe(true)
  expect(validateRemoteSettingsPatch({ cleanupPeriodDays: 0 })).toBe(true)
  expect(validateRemoteSettingsPatch({ cleanupPeriodDays: 3650 })).toBe(true)
  expect(validateRemoteSettingsPatch({ cleanupPeriodDays: 3651 })).toBe(false)
  expect(validateRemoteSettingsPatch({ cleanupPeriodDays: 1.5 })).toBe(false)
  expect(validateRemoteSettingsPatch({ cleanupPeriodDays: '30' })).toBe(false)
  // projection keeps object settings so the phone does not lose them on refresh
  const projected = projectRemoteSettings({
    webSearch: { mode: 'brave', tavilyApiKey: '', braveApiKey: 'b' },
    updateProxy: { mode: 'manual', url: 'http://p:1' },
    network: { aiRequestTimeoutMs: 90000, proxy: { mode: 'manual', url: 'http://n:2' } },
    cleanupPeriodDays: 14,
    desktopNotificationsEnabled: true,
    agentTeamsEnabled: false,
    vccCompactBackend: 'llm',
  })
  expect(projected.webSearch).toEqual({ mode: 'brave', tavilyApiKey: '', braveApiKey: 'b' })
  expect(projected.updateProxy).toEqual({ mode: 'manual', url: 'http://p:1' })
  expect(projected.network).toEqual({ aiRequestTimeoutMs: 90000, proxy: { mode: 'manual', url: 'http://n:2' } })
  expect(projected.cleanupPeriodDays).toBe(14)
  expect(projected.desktopNotificationsEnabled).toBe(true)
  expect(projected.agentTeamsEnabled).toBe(false)
  expect(projected.vccCompactBackend).toBe('llm')
  expect(projectRemoteSettings({ vccCompactBackend: 'bogus' }).vccCompactBackend).toBe('bogus')
  expect('network' in projectRemoteSettings({ network: { aiRequestTimeoutMs: 1 } })).toBe(false)
  // autoQuestion nested object (upstream)
  expect(validateRemoteSettingsPatch({ autoQuestion: { enabled: true, timeoutMinutes: 5 } })).toBe(true)
  expect(validateRemoteSettingsPatch({ autoQuestion: { enabled: true, timeoutMinutes: 3 } })).toBe(false)
  expect(validateRemoteSettingsPatch({ autoQuestion: { enabled: true, timeoutMinutes: 5, future: true } })).toBe(false)
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
