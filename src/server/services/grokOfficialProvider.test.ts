import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearGrokModelCatalogCache,
  fetchGrokModelCatalog,
} from '../../services/grokAuth/modelCatalog.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import { buildGrokOfficialRuntimeEnv } from './grokOfficialProvider.js'

describe('Grok Official runtime environment', () => {
  afterEach(() => {
    clearGrokModelCatalogCache()
  })

  test('carries remotely discovered model context windows into the runtime', async () => {
    await fetchGrokModelCatalog(async () => Response.json({
      models: [{
        id: 'grok-next-preview',
        name: 'Grok Next Preview',
        context_window: 375_000,
        supported_in_api: true,
      }, {
        id: 'grok-window-unknown',
        name: 'Grok Window Unknown',
        supported_in_api: true,
      }],
    }), 'access')

    const env = buildGrokOfficialRuntimeEnv()
    const windows = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>

    expect(windows['grok-next-preview']).toBe(375_000)
    expect(windows['grok-window-unknown']).toBeUndefined()
    expect(windows['grok-4.7']).toBe(500_000)
    expect(windows['grok-4.7-build-fast']).toBe(500_000)
    expect(windows['grok-4.6']).toBe(500_000)
    expect(windows['grok-4.5']).toBe(500_000)
  })
})
