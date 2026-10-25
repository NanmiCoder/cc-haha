import { expect, mock, test } from 'bun:test'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { createOfficialAgentSdkNetwork } from './officialAgentSdkNetwork.js'

test('SDK network updates preserve pinned credentials and update future child options after acknowledgement', async () => {
  const env = { ANTHROPIC_API_KEY: 'fake-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'haiku', HTTPS_PROXY: 'http://127.0.0.1:2' }
  const options: Options = { env: { ...env } }
  let acknowledge!: () => void
  const applyFlagSettings = mock(() => new Promise<void>(resolve => { acknowledge = resolve }))
  const network = createOfficialAgentSdkNetwork(env, options, { applyFlagSettings })
  const updating = network.update({ HTTPS_PROXY: 'http://127.0.0.1:3', API_TIMEOUT_MS: '180000' })
  await Promise.resolve()
  expect(options.env?.HTTPS_PROXY).toBe('http://127.0.0.1:2')
  expect(applyFlagSettings).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({
    ANTHROPIC_API_KEY: 'fake-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'haiku',
    ANTHROPIC_AUTH_TOKEN: '', HTTPS_PROXY: 'http://127.0.0.1:3', API_TIMEOUT_MS: '180000',
  }) }))
  acknowledge()
  await updating
  expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3')
  expect(options.env?.API_TIMEOUT_MS).toBe('180000')
})

test('SDK network update cannot modify the selected account, tool permissions or arbitrary environment', async () => {
  const applyFlagSettings = mock(async () => {})
  const network = createOfficialAgentSdkNetwork({}, {}, { applyFlagSettings })
  for (const value of [null, [], { ANTHROPIC_BASE_URL: 'https://other.invalid' }, { CLAUDE_CODE_OAUTH_TOKEN: 'fake' }, { NODE_OPTIONS: 'x' }, { HTTPS_PROXY: 42 }]) {
    await expect(network.update(value)).rejects.toThrow('Invalid SDK network')
  }
  expect(applyFlagSettings).not.toHaveBeenCalled()
})

test('SDK network rejection leaves state unchanged and later updates recover with serialized merging', async () => {
  const options: Options = { env: { HTTPS_PROXY: 'old' } }
  const calls: Record<string, unknown>[] = []
  let fail = true
  const network = createOfficialAgentSdkNetwork({ HTTPS_PROXY: 'old' }, options, {
    async applyFlagSettings(settings) {
      calls.push(settings)
      if (fail) { fail = false; throw new Error('fixture rejected') }
    },
  })
  await expect(network.update({ HTTPS_PROXY: 'rejected' })).rejects.toThrow('fixture rejected')
  expect(options.env?.HTTPS_PROXY).toBe('old')
  await Promise.all([network.update({ HTTPS_PROXY: 'new' }), network.update({ API_TIMEOUT_MS: '10000' })])
  expect(calls.at(-1)).toMatchObject({ env: { HTTPS_PROXY: 'new', API_TIMEOUT_MS: '10000' } })
  await network.update({ HTTPS_PROXY: '' })
  expect(options.env?.HTTPS_PROXY).toBe('')
})

test('SDK credential updates share acknowledgement and serialization with network changes and child settings', async () => {
  const env = { ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', HTTPS_PROXY: 'old-proxy' }
  const options: Options = { env: { ...env } }
  const applyFlagSettings = mock(async (_settings: unknown) => {})
  const updateSettings = mock((_variables: Record<string, string>) => {})
  const network = createOfficialAgentSdkNetwork(env, options, { applyFlagSettings }, updateSettings)
  applyFlagSettings.mockRejectedValueOnce(new Error('credential rejected'))
  await expect(network.updateCredentials('rejected-key')).rejects.toThrow('credential rejected')
  expect(env.ANTHROPIC_API_KEY).toBe('old-key')
  expect(updateSettings).not.toHaveBeenCalled()
  await Promise.all([network.updateCredentials('new-key'), network.update({ HTTPS_PROXY: 'new-proxy' })])
  expect(applyFlagSettings).toHaveBeenLastCalledWith({ env: expect.objectContaining({
    ANTHROPIC_API_KEY: 'new-key', ANTHROPIC_AUTH_TOKEN: '', HTTPS_PROXY: 'new-proxy', ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  }) })
  expect(env.ANTHROPIC_API_KEY).toBe('new-key')
  expect(options.env?.ANTHROPIC_API_KEY).toBe('new-key')
  expect(updateSettings).toHaveBeenCalledWith({ ANTHROPIC_API_KEY: 'new-key', ANTHROPIC_AUTH_TOKEN: '' })
  for (const key of [null, '', ' ', { apiKey: 'unexpected-object' }]) {
    await expect(network.updateCredentials(key)).rejects.toThrow('Invalid SDK provider credential update')
  }
  expect(applyFlagSettings).toHaveBeenCalledTimes(3)
})
