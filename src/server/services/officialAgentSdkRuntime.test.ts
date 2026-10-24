import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SavedProvider } from '../types/provider.js'
import { assertConversationRuntime, buildOfficialAgentSdkEnvironment, buildOfficialAgentSdkLaunchArgs, markAgentSdkSession, readConversationRuntime, resolveOfficialAgentSdkModel } from './officialAgentSdkRuntime.js'

const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const provider = {
  runtime: 'agent-sdk', apiFormat: 'anthropic', authStrategy: 'api_key', baseUrl: 'https://api.anthropic.com', apiKey: 'fake-key',
  models: { main: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' },
  model1mSupport: { main: true },
} as SavedProvider

test('SDK environment isolates inherited credentials and CLI identity while preserving networking', () => {
  const env = buildOfficialAgentSdkEnvironment({
    PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:1234',
    ANTHROPIC_API_KEY: 'stale', ANTHROPIC_AUTH_TOKEN: 'oauth', ANTHROPIC_CUSTOM_HEADERS: 'unsafe',
    CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_ATTRIBUTION_HEADER: '1', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'stale', CC_HAHA_TEAM_LEADER_RUNTIME: '{}',
  }, provider, '/temporary/config')
  expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'fake-key', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_MODEL: 'claude-opus-5-5[1m]', HTTPS_PROXY: 'http://127.0.0.1:1234', CLAUDE_CONFIG_DIR: '/temporary/config' })
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_ATTRIBUTION_HEADER', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_OAUTH_TOKEN', 'CC_HAHA_TEAM_LEADER_RUNTIME']) expect(env).not.toHaveProperty(key)
})

test('legacy sessions migrate without rewriting history and SDK markers survive restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-sdk-runtime-')); temporary.push(directory)
  expect(readConversationRuntime(directory, 'old-session')).toBe('claude-code')
  expect(() => assertConversationRuntime({ requested: 'agent-sdk', recorded: 'claude-code', hasMessages: true })).toThrow('Start a new conversation')
  markAgentSdkSession(directory, 'new-session')
  const file = join(directory, 'cc-haha/session-runtimes/new-session.json')
  const original = readFileSync(file, 'utf8')
  markAgentSdkSession(directory, 'new-session')
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(readConversationRuntime(directory, 'new-session')).toBe('agent-sdk')
  expect(() => assertConversationRuntime({ requested: 'claude-code', recorded: 'agent-sdk', hasMessages: true })).toThrow('Select an Agent SDK provider')
  writeFileSync(file, '{"version":99,"runtime":"agent-sdk"}')
  expect(() => readConversationRuntime(directory, 'new-session')).toThrow('Unsupported')
  expect(() => markAgentSdkSession(directory, '../outside')).toThrow('Invalid session')
})

test('SDK custom sessions can start fresh while history runtime boundaries remain enforced', () => {
  for (const extra of [{ teamWorker: true }, { sideChat: true }, { lean: true }]) {
    expect(() => assertConversationRuntime({ requested: 'agent-sdk', recorded: 'claude-code', hasMessages: false, ...extra })).not.toThrow()
    expect(() => assertConversationRuntime({ requested: 'agent-sdk', recorded: 'claude-code', hasMessages: true, ...extra })).toThrow('Start a new conversation')
  }
})

test('SDK launch uses its own entrypoint and never an arbitrary installed Claude CLI', () => {
  expect(buildOfficialAgentSdkLaunchArgs(['--model', 'claude-opus-5-5'], { execPath: '/app/claude-sidecar', appRoot: '/resources' })).toEqual(['/app/claude-sidecar', 'agent-sdk', '--app-root', '/resources', '--model', 'claude-opus-5-5'])
  expect(buildOfficialAgentSdkLaunchArgs([], { execPath: '/usr/local/bin/bun' })[3]).toEndWith('/entrypoints/officialAgentSdk.ts')
  expect(() => buildOfficialAgentSdkLaunchArgs([], { execPath: '/usr/local/bin/claude' })).toThrow('Rebuild')
})

test('selected model preserves its configured 1M context capability without changing other models', () => {
  expect(resolveOfficialAgentSdkModel(provider)).toBe('claude-opus-5-5[1m]')
  expect(resolveOfficialAgentSdkModel(provider, 'claude-opus-5-5')).toBe('claude-opus-5-5[1m]')
  expect(resolveOfficialAgentSdkModel(provider, 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]')
  expect(resolveOfficialAgentSdkModel(provider, 'claude-haiku-5-5')).toBe('claude-haiku-5-5')
})

test('SDK behavior environment preserves native effort overrides and workflow opt-outs but no identity', () => {
  const env = buildOfficialAgentSdkEnvironment({ CLAUDE_CODE_EFFORT_LEVEL: 'low', CLAUDE_CODE_DISABLE_WORKFLOWS: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, provider, '/temporary/config')
  expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low')
  expect(env.CLAUDE_CODE_DISABLE_WORKFLOWS).toBe('1')
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
})
