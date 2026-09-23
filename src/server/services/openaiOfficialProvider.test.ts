import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearOpenAICodexModelCatalogCache,
  getOpenAICodexModelCatalog,
} from '../../services/openaiAuth/modelCatalog.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import { buildOpenAIOfficialRuntimeEnv } from './openaiOfficialProvider.js'

afterEach(() => {
  clearOpenAICodexModelCatalogCache()
})

describe('ChatGPT Official runtime environment', () => {
  test('includes context windows from the refreshed account catalog', async () => {
    await getOpenAICodexModelCatalog({
      tokens: { accessToken: 'test-token', accountId: 'acct_runtime' },
      forceRefresh: true,
      fetchOverride: async () => Response.json({
        models: [{
          slug: 'gpt-account-model',
          display_name: 'GPT Account Model',
          visibility: 'list',
          context_window: 400_000,
          effective_context_window_percent: 90,
        }],
      }),
    })

    const env = buildOpenAIOfficialRuntimeEnv()
    const contextWindows = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>

    expect(contextWindows['gpt-account-model']).toBe(360_000)
    expect(contextWindows['gpt-5.6-sol']).toBe(353_400)
  })

  test('includes the Astra effective context window without changing the default model', () => {
    const env = buildOpenAIOfficialRuntimeEnv()
    const windows = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>

    expect(windows['gpt-6-astra']).toBe(997_500)
    expect(windows['gpt-5.6-sol']).toBe(353_400)
    expect(env.ANTHROPIC_MODEL).toBe('gpt-5.6-sol')
  })
})
