import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { createOfficialAgentSdkSettingsFile, officialAgentSdkProviderSettings, parseOfficialAgentSdkLaunchOptions } from './officialAgentSdkConfiguration.js'

describe('official Agent SDK configuration', () => {
  test('provider overlay pins selected routing without replacing project feature settings or changing files', () => {
    const settings = officialAgentSdkProviderSettings({ ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:43210', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku', ENABLE_TOOL_SEARCH: 'false' })
    expect(settings.env).toMatchObject({ ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:43210', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku', ENABLE_TOOL_SEARCH: 'false', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_OAUTH_TOKEN: '' })
    expect(settings.apiKeyHelper).toBe('')
    expect(settings).not.toHaveProperty('hooks')
    expect(settings).not.toHaveProperty('permissions')
    expect(settings.env).not.toHaveProperty('HOME')
    expect(settings.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
  })

  test('accepts host team definitions and appends without allowing arbitrary credentials, settings or permissions', () => {
    const options = { agent: 'reviewer', agents: { reviewer: { description: 'Review project', prompt: 'Review this code', model: 'inherit', tools: ['Read'], disallowedTools: ['Bash'], skills: ['review'], effort: 'low' } }, tools: ['Read'], disallowedTools: ['Write'], appendSystemPrompt: 'Project task', maxTurns: 10, additionalDirectories: ['/fixture/shared'], plugins: [{ type: 'local', path: '/fixture/plugin' }] }
    expect(parseOfficialAgentSdkLaunchOptions(JSON.stringify(options))).toEqual(options)
    expect(parseOfficialAgentSdkLaunchOptions(undefined)).toEqual({})
    for (const invalid of [
      { env: { ANTHROPIC_API_KEY: 'wrong' } }, { settings: { env: {} } }, { permissionMode: 'bypassPermissions' },
      { agents: { reviewer: { description: 'x', prompt: 'x', permissionMode: 'invalid-mode' } } },
      { agents: { reviewer: { description: 'x', prompt: 5 } } }, { maxTurns: 0 }, { tools: 'Read' },
      { plugins: [{ type: 'local', path: 'relative' }] }, { additionalDirectories: ['relative'] },
    ]) expect(() => parseOfficialAgentSdkLaunchOptions(JSON.stringify(invalid))).toThrow()
  })
  test('validates standalone team-worker hooks without accepting unknown silently ignored fields', () => {
    const agentHooks = { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: '/fixture/check', args: ['--check'], onFailure: 'block', timeout: 5 }] }] }
    expect(parseOfficialAgentSdkLaunchOptions(JSON.stringify({ agentHooks })).agentHooks).toEqual(agentHooks)
    for (const agentHooks of [
      { NotAnEvent: [] }, { PreToolUse: [{ hooks: [{ type: 'command' }] }] },
      { PreToolUse: [{ hooks: [{ type: 'command', command: 'check', unknown: true }] }] },
      { PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1', headers: { x: 1 } }] }] },
    ]) expect(() => parseOfficialAgentSdkLaunchOptions(JSON.stringify({ agentHooks }))).toThrow()
  })

})

test('updating the private SDK overlay preserves credentials and hooks for new workflow children', () => {
  const hooks = { PreToolUse: [{ hooks: [{ type: 'command' as const, command: 'exit 0' }] }] }
  const file = createOfficialAgentSdkSettingsFile({ env: { ANTHROPIC_API_KEY: 'fake-key', HTTPS_PROXY: 'old' }, hooks })
  try {
    file.updateEnv({ HTTPS_PROXY: 'new', HTTP_PROXY: '' })
    expect(JSON.parse(readFileSync(file.path, 'utf8'))).toEqual({ env: { ANTHROPIC_API_KEY: 'fake-key', HTTPS_PROXY: 'new', HTTP_PROXY: '' }, hooks })
    expect(statSync(file.path).mode & 0o777).toBe(0o600)
  } finally { file.close() }
  expect(() => file.updateEnv({ HTTPS_PROXY: 'later' })).toThrow('closed')
})
