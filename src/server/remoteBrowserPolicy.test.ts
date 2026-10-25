import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import { projectRemoteAgents, projectRemoteConnectors, projectRemoteProvider, projectRemoteSettings, projectRemoteWorkflows, remoteProviderRouteAllowed, remoteSettingsRouteAllowed, validateRemoteSettingsPatch } from './remoteBrowserPolicy.js'
import { SavedProviderSchema, ImageGenerationConfigSchema } from './types/provider.js'

test('remote image settings preserve the protocol while redacting image credentials', () => {
  const provider = SavedProviderSchema.parse({
    id: 'fixture', presetId: 'custom', name: 'Fixture',
    apiKey: 'chat-secret', baseUrl: 'https://chat.example.test',
    models: { main: 'chat-model', haiku: '', sonnet: '', opus: '' },
    imageGeneration: {
      protocol: 'gemini_native', model: 'image-model', apiKey: 'image-secret',
      baseUrl: 'https://images.example.test', futureField: 'private-extension',
    },
  })
  expect(projectRemoteProvider(provider).imageGeneration).toEqual({
    protocol: 'gemini_native', model: 'image-model',
    baseUrl: 'https://images.example.test', apiKey: '', hasApiKey: true,
  })
  expect(ImageGenerationConfigSchema.safeParse({ model: 'image-model', protocol: 'unknown' }).success).toBe(false)
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
      expect(readFileSync(path.join(home, '.claude', 'REMOTE_SETTINGS_INTEGRATION_PASSED'), 'utf8')).toBe('passed')
    } finally { clearTimeout(timeout); child.kill() }
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 20_000)


test('remote auto-question settings reject malformed input and project only normalized fields', () => {
  for (const autoQuestion of [null, [], true, 'true', {}, { enabled: 'true', timeoutMinutes: 5 }, { enabled: true }, { enabled: false, timeoutMinutes: -1 }]) expect(validateRemoteSettingsPatch({ autoQuestion })).toBe(false)
  expect(projectRemoteSettings({ autoQuestion: { enabled: true, timeoutMinutes: 5, secret: 'hidden' }, env: { TOKEN: 'hidden' } })).toEqual({ autoQuestion: { enabled: true, timeoutMinutes: 5 } })
})


test('remote composers can read the desktop team capability without changing it', () => {
  expect(projectRemoteSettings({ agentTeamsEnabled: false, env: { TOKEN: 'hidden' } })).toEqual({ agentTeamsEnabled: false })
  expect(projectRemoteSettings({ agentTeamsEnabled: true })).toEqual({ agentTeamsEnabled: true })
  expect(validateRemoteSettingsPatch({ agentTeamsEnabled: true })).toBe(false)
})

test('remote projections drop nested and unknown fields and tolerate malformed bodies', () => {
  expect(projectRemoteConnectors({ items: [{ id: 'x', status: 'ready', operation: { kind: 'check', authUrl: 'https://secret.test' }, error: 'boom', setupFields: [{}] }, 'junk', null] }))
    .toEqual({ items: [{ id: 'x', status: 'ready', operation: { kind: 'check' } }] })
  expect(projectRemoteConnectors({ items: [{ id: 'y', operation: 'oops' }] })).toEqual({ items: [{ id: 'y' }] })
  expect(projectRemoteConnectors({})).toEqual({ items: [] })
  expect(projectRemoteWorkflows({ workflows: [{ name: 'w', filePath: '/p', script: 'code' }] })).toEqual({ workflows: [{ name: 'w' }] })
  expect(projectRemoteWorkflows({ workflows: 'nope' })).toEqual({ workflows: [] })
  expect(projectRemoteAgents({ activeAgents: [{ agentType: 'a', systemPrompt: 's', baseDir: '/b' }] })).toEqual({ activeAgents: [{ agentType: 'a' }], allAgents: [] })
})
