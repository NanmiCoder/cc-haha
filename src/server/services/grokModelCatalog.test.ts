import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearGrokModelCatalogCache } from '../../services/grokAuth/modelCatalog.js'
import { GROK_MODEL_CATALOG } from '../../services/grokAuth/models.js'
import { getDesktopGrokModelCatalog } from './grokModelCatalog.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import { SettingsService } from './settingsService.js'

describe('desktop Grok catalog credentials and network policy', () => {
  let directory: string
  let originalConfig: string | undefined
  let originalTokenFile: string | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'desktop-grok-models-'))
    originalConfig = process.env.CLAUDE_CONFIG_DIR
    originalTokenFile = process.env.GROK_OAUTH_FILE
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.GROK_OAUTH_FILE = join(directory, 'cli-oauth.json')
    await writeFile(process.env.GROK_OAUTH_FILE, JSON.stringify({
      accessToken: 'other-cli-token', refreshToken: 'other-cli-refresh', expiresAt: Date.now() + 3_600_000,
    }))
    spyOn(SettingsService.prototype, 'getUserSettings').mockResolvedValue({
      network: { proxy: { mode: 'manual', url: 'http://127.0.0.1:8899' } },
    })
    clearGrokModelCatalogCache()
  })

  afterEach(async () => {
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfig
    if (originalTokenFile === undefined) delete process.env.GROK_OAUTH_FILE
    else process.env.GROK_OAUTH_FILE = originalTokenFile
    clearGrokModelCatalogCache()
    mock.restore()
    await rm(directory, { recursive: true, force: true })
  })

  const saveAccount = (account: string) => hahaGrokOAuthService.saveTokens({
    accessToken: `desktop-token-${account}`, refreshToken: null, expiresAt: null, email: null,
  })

  test('uses desktop credentials and Settings proxy, sharing cache only for the same authenticated account', async () => {
    const requests: Array<{ authorization: string | null; proxy: unknown }> = []
    const fetchOverride = (async (_input, init) => {
      const authorization = new Headers(init?.headers).get('Authorization')
      requests.push({ authorization, proxy: (init as RequestInit & { proxy?: string })?.proxy })
      return Response.json({ models: [{ id: authorization?.endsWith('account-a') ? 'grok-account-a' : 'grok-account-b' }] })
    }) as typeof fetch
    await saveAccount('account-a')
    const first = await getDesktopGrokModelCatalog({ fetchOverride, forceRefresh: true, throwOnError: true })
    expect(first.map(model => model.value)).toEqual(['grok-account-a'])
    expect(requests).toEqual([{ authorization: 'Bearer desktop-token-account-a', proxy: 'http://127.0.0.1:8899' }])
    expect(await getDesktopGrokModelCatalog({ fetchOverride })).toEqual(first)
    expect(requests).toHaveLength(1)

    await saveAccount('account-b')
    const second = await getDesktopGrokModelCatalog({ fetchOverride, forceRefresh: true, throwOnError: true })
    expect(second.map(model => model.value)).toEqual(['grok-account-b'])
    expect(requests[1]?.authorization).toBe('Bearer desktop-token-account-b')

    await hahaGrokOAuthService.deleteTokens()
    expect(await getDesktopGrokModelCatalog({ fetchOverride, forceRefresh: true })).toEqual(GROK_MODEL_CATALOG)
    await expect(getDesktopGrokModelCatalog({ fetchOverride, forceRefresh: true, throwOnError: true }))
      .rejects.toThrow('Grok OAuth token is unavailable')
    expect(requests).toHaveLength(2)
  })

  test('does not use CLI credentials when desktop credentials are unreadable', async () => {
    await saveAccount('account-a')
    await writeFile(hahaGrokOAuthService.getOAuthFilePath(), 'invalid JSON')
    const fetchOverride = mock(async () => { throw new Error('must not request a CLI catalog') }) as unknown as typeof fetch
    expect(await getDesktopGrokModelCatalog({ fetchOverride, forceRefresh: true })).toEqual(GROK_MODEL_CATALOG)
    expect(fetchOverride).not.toHaveBeenCalled()
  })
})
