import { describe, expect, spyOn, test } from 'bun:test'
import * as auth from '../auth.js'
import { getDefaultFableModel, getDefaultHaikuModel, getDefaultOpusModel, getDefaultSonnetModel } from './model.js'
import { getAgentModel } from './agent.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'
import { isAnthropicAuthEnabled, isClaudeAISubscriber, getAnthropicApiKey, getAuthTokenSource } from '../auth.js'
import { runWithProviderRuntime, type ProviderRuntimeContext } from '../../services/api/providerRuntimeContext.js'
import { getAllModelBetas } from '../betas.js'
import { getConfiguredProviderOutputBudget } from '../../services/api/outputBudget.js'

const runtime = (providerId: string, env: NodeJS.ProcessEnv): ProviderRuntimeContext => ({
  providerId,
  runtimeKind: 'anthropic_compatible',
  env,
})

describe('subagent provider model and authentication isolation', () => {
  test('native account aliases honor the selected provider tier mapping', () => {
    const active = spyOn(auth, 'isOpenAIAuthActive').mockReturnValue(true)
    try {
      runWithProviderRuntime({
        providerId: 'openai-official', runtimeKind: 'openai_oauth',
        env: {
          ANTHROPIC_DEFAULT_FABLE_MODEL: 'target-fable',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'target-opus',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'target-sonnet',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'target-haiku',
        },
      }, () => {
        expect([getDefaultFableModel(), getDefaultOpusModel(), getDefaultSonnetModel(), getDefaultHaikuModel()])
          .toEqual(['target-fable', 'target-opus', 'target-sonnet', 'target-haiku'])
      })
    } finally {
      active.mockRestore()
    }
  })
  test('does not share beta caches or output limits between providers using the same model', () => {
    for (const providerId of ['a', 'b']) {
      runWithProviderRuntime(runtime(providerId, {
        ANTHROPIC_BASE_URL: `https://${providerId}.invalid`,
        ANTHROPIC_BETAS: `${providerId}-explicit-beta`,
        CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: providerId === 'a' ? '4096' : '8192',
      }), () => {
        const betas = getAllModelBetas('claude-sonnet-4-6')
        expect(betas).toContain(`${providerId}-explicit-beta`)
        expect(betas).not.toContain(`${providerId === 'a' ? 'b' : 'a'}-explicit-beta`)
        expect(getConfiguredProviderOutputBudget()).toBe(providerId === 'a' ? 4096 : 8192)
      })
    }
  })
  test('resolves aliases against each provider while concurrent agents are suspended', async () => {
    const results = await Promise.all(['a', 'b'].map(providerId => runWithProviderRuntime(runtime(providerId, {
      ANTHROPIC_BASE_URL: `https://${providerId}.invalid`,
      ANTHROPIC_DEFAULT_OPUS_MODEL: `${providerId}-opus`,
      ANTHROPIC_API_KEY: `${providerId}-key`,
    }), async () => {
      await new Promise(resolve => setTimeout(resolve, providerId === 'a' ? 10 : 1))
      return [getAgentModel('opus', `${providerId}-main`), getAnthropicApiKey(), isFirstPartyAnthropicBaseUrl()]
    })))
    expect(results).toEqual([['a-opus', 'a-key', false], ['b-opus', 'b-key', false]])
  })

  test('an explicit API provider never uses the session OAuth or cloud-provider identity', () => {
    runWithProviderRuntime(runtime('api-provider', { ANTHROPIC_AUTH_TOKEN: 'api-token' }), () => {
      expect(getAPIProvider()).toBe('firstParty')
      expect(isAnthropicAuthEnabled()).toBe(false)
      expect(isClaudeAISubscriber()).toBe(false)
      expect(getAnthropicApiKey()).toBeNull()
      expect(getAuthTokenSource()).toEqual({ source: 'ANTHROPIC_AUTH_TOKEN', hasToken: true })
    })
  })

  test('Claude Official identity is explicit and does not depend on the session account', () => {
    runWithProviderRuntime({
      providerId: 'claude-official',
      runtimeKind: 'claude_oauth',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'isolated-official-token' },
    }, () => {
      expect(isAnthropicAuthEnabled()).toBe(true)
      expect(isClaudeAISubscriber()).toBe(true)
      expect(getAnthropicApiKey()).toBeNull()
      expect(getAuthTokenSource()).toEqual({ source: 'CLAUDE_CODE_OAUTH_TOKEN', hasToken: true })
    })
  })
})
