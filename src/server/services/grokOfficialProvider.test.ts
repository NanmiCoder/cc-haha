import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearGrokModelCatalogCache,
  getGrokModelCatalog,
} from '../../services/grokAuth/modelCatalog.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import { buildGrokOfficialRuntimeEnv, GROK_MODEL_CATALOG_ENV_KEY } from './grokOfficialProvider.js'

describe('Grok Official runtime environment', () => {
  afterEach(() => {
    clearGrokModelCatalogCache()
  })

  test('carries remotely discovered model context windows into the runtime without leaking into default builds', async () => {
    const catalog = await getGrokModelCatalog({ accessToken: 'access', forceRefresh: true, fetchOverride: async () => Response.json({
      models: [{
        id: 'grok-next-preview',
        name: 'Grok Next Preview',
        context_window: 375_000,
        supported_in_api: true,
        supportsReasoningEffort: true,
        reasoningEffort: 'low',
        reasoningEfforts: ['low', 'xhigh', 'max'],
      }, {
        id: 'grok-window-unknown',
        name: 'Grok Window Unknown',
        supported_in_api: true,
        supportsReasoningEffort: false,
      }],
    }) })

    const env = buildGrokOfficialRuntimeEnv(undefined, undefined, catalog)
    const windows = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>

    expect(windows['grok-next-preview']).toBe(375_000)
    expect(windows['grok-window-unknown']).toBeUndefined()
    expect(windows['grok-4.7']).toBe(500_000)
    expect(windows['grok-4.7-build-fast']).toBe(500_000)
    expect(windows['grok-4.6']).toBe(500_000)
    expect(windows['grok-4.5']).toBe(500_000)
    expect(JSON.parse(env[GROK_MODEL_CATALOG_ENV_KEY]!)).toMatchObject([
      { value: 'grok-next-preview', supportsReasoningEffort: true, reasoningEffort: 'low', reasoningEfforts: ['low', 'xhigh', 'max'] },
      { value: 'grok-window-unknown', supportsReasoningEffort: false },
    ])

    // Omitting the explicit catalog keeps only bundled defaults so another
    // account's live listing never leaks into persisted or logged-out builds.
    const defaultWindows = JSON.parse(buildGrokOfficialRuntimeEnv()[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>
    expect(defaultWindows['grok-next-preview']).toBeUndefined()
    expect(defaultWindows['grok-4.7']).toBe(500_000)
  })

  test('layers live catalog windows over bundled defaults and user overrides on top', () => {
    const env = buildGrokOfficialRuntimeEnv(
      undefined,
      { 'grok-4.7': 256_000, 'grok-next': 700_000 },
      [
        { value: 'grok-4.7', label: 'Grok 4.7', description: '', contextWindow: 500_000 },
        { value: 'grok-next', label: 'Grok Next', description: '', contextWindow: 1_000_000 },
      ],
    )
    const windows = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>

    expect(windows['grok-4.7']).toBe(256_000)
    expect(windows['grok-next']).toBe(700_000)
    expect(windows['grok-4.6']).toBe(500_000)
    expect(windows['grok-4.5']).toBe(500_000)
  })
})
