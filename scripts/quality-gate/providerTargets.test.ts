import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatProviderTargets,
  loadProviderIndex,
  parseBaselineTargetValues,
} from './providerTargets'

function withProviderIndex(index: unknown, fn: (configDir: string) => void) {
  const configDir = join(tmpdir(), `quality-provider-targets-${crypto.randomUUID()}`)
  mkdirSync(join(configDir, 'yuanclaw'), { recursive: true })
  writeFileSync(join(configDir, 'yuanclaw', 'providers.json'), JSON.stringify(index, null, 2))

  try {
    fn(configDir)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

describe('quality gate provider targets', () => {
  test('lists copyable provider-model selectors without exposing keys', () => {
    withProviderIndex({
      activeId: 'provider-kimi',
      providers: [
        {
          id: 'provider-kimi',
          presetId: 'volcengine',
          name: 'Volcengine Codingplan',
          apiKey: 'secret-key',
          baseUrl: 'https://example.invalid',
          apiFormat: 'openai_chat',
          models: {
            main: 'kimi-k2.6',
            haiku: 'kimi-k2.6',
            sonnet: 'kimi-k2.6-thinking',
            opus: 'kimi-k2.6-thinking',
          },
        },
      ],
    }, (configDir) => {
      const output = formatProviderTargets(loadProviderIndex(configDir), configDir)

      expect(output).toContain('Volcengine Codingplan')
      expect(output).toContain('--provider-model volcengine-codingplan:main:volcengine-codingplan-main')
      expect(output).toContain('--provider-model volcengine-codingplan:sonnet:volcengine-codingplan-sonnet')
      expect(output).not.toContain('secret-key')
    })
  })

  test('parses provider-model by provider slug instead of requiring UUID', () => {
    withProviderIndex({
      activeId: null,
      providers: [
        {
          id: 'provider-minimax',
          presetId: 'minimax',
          name: 'MiniMax',
          apiKey: 'secret-key',
          baseUrl: 'https://example.invalid',
          apiFormat: 'openai_chat',
          models: {
            main: 'MiniMax-M2.7-highspeed',
            haiku: 'MiniMax-M2.7-highspeed',
            sonnet: 'MiniMax-M2.7-highspeed',
            opus: 'MiniMax-M2.7-highspeed',
          },
        },
      ],
    }, (configDir) => {
      const targets = parseBaselineTargetValues(
        ['minimax:MiniMax-M2.7-highspeed'],
        loadProviderIndex(configDir),
      )

      expect(targets).toEqual([
        {
          providerId: 'provider-minimax',
          modelId: 'MiniMax-M2.7-highspeed',
          label: 'minimax-MiniMax-M2.7-highspeed',
        },
      ])
    })
  })

  test('parses provider-model by role so model IDs may contain colons', () => {
    withProviderIndex({
      activeId: null,
      providers: [
        {
          id: 'provider-anthropic-proxy',
          presetId: 'proxy',
          name: 'Anthropic Proxy',
          apiKey: 'secret-key',
          baseUrl: 'https://example.invalid',
          apiFormat: 'anthropic',
          models: {
            main: 'anthropic/claude-sonnet-4.6',
            haiku: 'anthropic/claude-haiku-4.5:thinking',
            sonnet: 'anthropic/claude-sonnet-4.6',
            opus: 'anthropic/claude-opus-4.7',
          },
        },
      ],
    }, (configDir) => {
      const targets = parseBaselineTargetValues(
        ['anthropic-proxy:haiku:proxy-haiku-thinking'],
        loadProviderIndex(configDir),
      )

      expect(targets).toEqual([
        {
          providerId: 'provider-anthropic-proxy',
          modelId: 'anthropic/claude-haiku-4.5:thinking',
          label: 'proxy-haiku-thinking',
        },
      ])
    })
  })

  test('does not treat shared preset ids as provider selectors', () => {
    withProviderIndex({
      activeId: null,
      providers: [
        {
          id: 'provider-one',
          presetId: 'custom',
          name: 'Provider One',
          apiKey: 'secret-key',
          baseUrl: 'https://example.invalid',
          apiFormat: 'anthropic',
          models: { main: 'model-one', haiku: 'model-one', sonnet: 'model-one', opus: 'model-one' },
        },
        {
          id: 'provider-two',
          presetId: 'custom',
          name: 'Provider Two',
          apiKey: 'secret-key',
          baseUrl: 'https://example.invalid',
          apiFormat: 'anthropic',
          models: { main: 'model-two', haiku: 'model-two', sonnet: 'model-two', opus: 'model-two' },
        },
      ],
    }, (configDir) => {
      expect(() => parseBaselineTargetValues(['custom:main'], loadProviderIndex(configDir))).toThrow('Unknown provider')
      expect(parseBaselineTargetValues(['provider-one:main'], loadProviderIndex(configDir))[0]).toEqual({
        providerId: 'provider-one',
        modelId: 'model-one',
        label: 'provider-one-model-one',
      })
    })
  })

  test('keeps current runtime and explicit UUID selectors supported', () => {
    const targets = parseBaselineTargetValues([
      'current:current',
      '11111111-1111-4111-8111-111111111111:model-a:model-a-live',
    ])

    expect(targets).toEqual([
      { providerId: null, modelId: 'current', label: 'current-runtime' },
      {
        providerId: '11111111-1111-4111-8111-111111111111',
        modelId: 'model-a',
        label: 'model-a-live',
      },
    ])
  })
})
