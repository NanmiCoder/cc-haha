import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearOpenAICodexModelCatalogCache } from '../../services/openaiAuth/modelCatalog.js'
import { OPENAI_CODEX_MODEL_CATALOG } from '../../services/openaiAuth/models.js'
import { clearOpenAIOAuthTokenCache } from '../../services/openaiAuth/storage.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { getDesktopOpenAICodexModelCatalog } from './openaiModelCatalog.js'

describe('desktop OpenAI model catalog credentials', () => {
  let directory: string
  let originalConfig: string | undefined
  let originalTokenFile: string | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'desktop-openai-models-'))
    originalConfig = process.env.CLAUDE_CONFIG_DIR
    originalTokenFile = process.env.OPENAI_CODEX_OAUTH_FILE
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.OPENAI_CODEX_OAUTH_FILE = join(directory, 'cli-oauth.json')
    await writeFile(process.env.OPENAI_CODEX_OAUTH_FILE, JSON.stringify({
      accessToken: 'other-cli-token',
      accountId: 'other-cli-account',
      expiresAt: Date.now() + 3_600_000,
    }))
    clearOpenAIOAuthTokenCache()
    clearOpenAICodexModelCatalogCache()
  })

  afterEach(async () => {
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfig
    if (originalTokenFile === undefined) delete process.env.OPENAI_CODEX_OAUTH_FILE
    else process.env.OPENAI_CODEX_OAUTH_FILE = originalTokenFile
    clearOpenAIOAuthTokenCache()
    clearOpenAICodexModelCatalogCache()
    await rm(directory, { recursive: true, force: true })
  })

  const saveAccount = async (accountId: string) => {
    await hahaOpenAIOAuthService.saveTokens({
      accessToken: `desktop-token-${accountId}`,
      refreshToken: null,
      expiresAt: null,
      accountId,
      email: `${accountId}@example.test`,
    })
  }

  test('uses desktop credentials and isolates account switches and logout from CLI credentials', async () => {
    const requests: Headers[] = []
    const fetchOverride: typeof fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      requests.push(headers)
      return Response.json({ models: [{
        slug: `model-${headers.get('ChatGPT-Account-Id')}`,
        display_name: 'Account model',
        visibility: 'list',
      }] })
    }) as typeof fetch

    await saveAccount('account-a')
    const first = await getDesktopOpenAICodexModelCatalog({ fetchOverride, forceRefresh: true })
    expect(first.map(model => model.value)).toEqual(['model-account-a'])
    expect(requests[0]?.get('Authorization')).toBe('Bearer desktop-token-account-a')
    expect(requests[0]?.get('ChatGPT-Account-Id')).toBe('account-a')
    expect(await getDesktopOpenAICodexModelCatalog({ fetchOverride })).toEqual(first)
    expect(requests).toHaveLength(1)

    await saveAccount('account-b')
    const second = await getDesktopOpenAICodexModelCatalog({ fetchOverride, forceRefresh: true })
    expect(second.map(model => model.value)).toEqual(['model-account-b'])
    expect(requests[1]?.get('Authorization')).toBe('Bearer desktop-token-account-b')
    expect(await getDesktopOpenAICodexModelCatalog({ fetchOverride })).toEqual(second)

    await hahaOpenAIOAuthService.deleteTokens()
    expect(await getDesktopOpenAICodexModelCatalog({ fetchOverride, forceRefresh: true }))
      .toEqual(OPENAI_CODEX_MODEL_CATALOG)
    expect(requests).toHaveLength(2)
  })

  test('unreadable desktop tokens fall back without consulting CLI credentials', async () => {
    await saveAccount('account-a')
    await writeFile(hahaOpenAIOAuthService.getOAuthFilePath(), 'invalid JSON')
    let calls = 0
    const fetchOverride = (async () => {
      calls += 1
      throw new Error('unexpected request')
    }) as typeof fetch
    expect(await getDesktopOpenAICodexModelCatalog({ fetchOverride, forceRefresh: true }))
      .toEqual(OPENAI_CODEX_MODEL_CATALOG)
    expect(calls).toBe(0)
  })
})
