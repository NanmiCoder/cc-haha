import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  fetchGrokModelCatalog,
  getGrokModelCatalog,
  GROK_MODELS_ENDPOINT,
} from './modelCatalog.js'
import { GROK_CLI_VERSION } from './fetch.js'
import { GROK_OAUTH_FILE_ENV_KEY } from './storage.js'

describe('Grok model catalog', () => {
  let tmpDir: string
  let original: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-models-'))
    original = process.env[GROK_OAUTH_FILE_ENV_KEY]
    process.env[GROK_OAUTH_FILE_ENV_KEY] = path.join(tmpDir, 'tokens.json')
    await fs.writeFile(process.env[GROK_OAUTH_FILE_ENV_KEY], JSON.stringify({
      accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000,
    }))
  })

  afterEach(async () => {
    if (original === undefined) delete process.env[GROK_OAUTH_FILE_ENV_KEY]
    else process.env[GROK_OAUTH_FILE_ENV_KEY] = original
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('normalizes the official models response and filters non-API entries', async () => {
    let seen: { url: string; headers: Headers } | undefined
    const models = await fetchGrokModelCatalog(async (input, init) => {
      seen = { url: String(input), headers: new Headers(init?.headers) }
      return Response.json({ models: {
        build: {
          info: {
            id: 'grok-build',
            name: 'Grok Build',
            context_window: 500000,
            supported_in_api: false,
          },
        },
        frontier: {
          info: {
            id: 'grok-4.5',
            name: 'Grok 4.5',
            context_window: 500000,
            supported_in_api: true,
            supports_reasoning_effort: true,
            reasoning_effort: 'high',
            reasoning_efforts: [
              { value: 'high', default: true },
              { value: 'medium' },
              { value: 'low' },
            ],
          },
        },
      } })
    })
    expect(seen?.url).toBe(GROK_MODELS_ENDPOINT)
    expect(seen?.headers.get('Authorization')).toBe('Bearer access')
    expect(seen?.headers.get('x-grok-client-version')).toBe(GROK_CLI_VERSION)
    expect(GROK_MODELS_ENDPOINT).toEndWith('/v1/models')
    expect(models.map((model) => model.value)).toEqual(['grok-4.5'])
    expect(models[0]).toMatchObject({
      contextWindow: 500000,
      supportsReasoningEffort: true,
      reasoningEffort: 'high',
      reasoningEfforts: ['high', 'medium', 'low'],
    })
  })

  test('falls back to the static public catalog on failure', async () => {
    const models = await getGrokModelCatalog({
      forceRefresh: true,
      fetchOverride: async () => new Response('nope', { status: 503 }),
    })
    expect(models[0]?.value).toBe('grok-4.5')
    expect(models.some((model) => model.value === 'grok-4.5')).toBe(true)
  })
})
