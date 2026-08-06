import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { handleProvidersApi } from '../api/providers.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-presets-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

describe('provider presets API', () => {
  test('GET /api/providers/presets returns the configured presets', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/providers/presets')
    const response = await handleProvidersApi(req, url, segments)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ presets: PROVIDER_PRESETS })
  })

  test('configured presets include built-in official and custom entries', () => {
    expect(PROVIDER_PRESETS.some((preset) => preset.id === 'official')).toBe(true)
    expect(PROVIDER_PRESETS.some((preset) => preset.id === 'custom')).toBe(true)
  })

  test('local Anthropic-compatible presets appear immediately before custom', () => {
    expect(PROVIDER_PRESETS.at(-3)?.id).toBe('lmstudio')
    expect(PROVIDER_PRESETS.at(-2)?.id).toBe('ollama')
    expect(PROVIDER_PRESETS.at(-1)?.id).toBe('custom')
  })

  test('configured presets keep current default model ids aligned with official provider docs', () => {
    const lmstudio = PROVIDER_PRESETS.find((preset) => preset.id === 'lmstudio')
    const ollama = PROVIDER_PRESETS.find((preset) => preset.id === 'ollama')
    const deepseek = PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek')
    const zhipu = PROVIDER_PRESETS.find((preset) => preset.id === 'zhipuglm')
    const kimi = PROVIDER_PRESETS.find((preset) => preset.id === 'kimi')
    const minimax = PROVIDER_PRESETS.find((preset) => preset.id === 'minimax')
    const shengsuanyun = PROVIDER_PRESETS.find((preset) => preset.id === 'shengsuanyun')
    const teamorouter = PROVIDER_PRESETS.find((preset) => preset.id === 'teamorouter')
    const atlascloud = PROVIDER_PRESETS.find((preset) => preset.id === 'atlascloud')
    const xuanshuapi = PROVIDER_PRESETS.find((preset) => preset.id === 'xuanshuapi')
    const fennoai = PROVIDER_PRESETS.find((preset) => preset.id === 'fennoai')
    const qiniuai = PROVIDER_PRESETS.find((preset) => preset.id === 'qiniuai')

    expect(lmstudio?.baseUrl).toBe('http://localhost:1234')
    expect(lmstudio?.apiFormat).toBe('anthropic')
    expect(lmstudio?.authStrategy).toBe('auth_token_empty_api_key')
    expect(lmstudio?.defaultModels.main).toBe('qwen/qwen3.6-27b')
    expect(ollama?.baseUrl).toBe('http://localhost:11434')
    expect(ollama?.apiFormat).toBe('anthropic')
    expect(ollama?.authStrategy).toBe('auth_token_empty_api_key')
    expect(ollama?.defaultModels.main).toBe('qwen3.6:27b')
    expect(deepseek?.authStrategy).toBe('auth_token')
    expect(deepseek?.defaultModels.main).toBe('deepseek-v4-pro[1m]')
    expect(deepseek?.defaultModels.haiku).toBe('deepseek-v4-flash')
    expect(deepseek?.defaultModels.sonnet).toBe('deepseek-v4-pro[1m]')
    expect(deepseek?.defaultModels.opus).toBe('deepseek-v4-pro[1m]')
    expect(deepseek?.defaultEnv?.CC_HAHA_SEND_DISABLED_THINKING).toBeUndefined()
    expect(deepseek?.defaultEnv).toEqual({})
    expect(zhipu?.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(zhipu?.regionalEndpoints).toEqual([
      { region: 'cn_zh', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
      { region: 'global_en', baseUrl: 'https://api.z.ai/api/anthropic' },
    ])
    expect(zhipu?.authStrategy).toBe('auth_token')
    expect(zhipu?.defaultModels.main).toBe('glm-5.2[1m]')
    expect(zhipu?.defaultModels.haiku).toBe('glm-4.7')
    expect(zhipu?.defaultModels.sonnet).toBe('glm-5.2[1m]')
    expect(zhipu?.defaultModels.opus).toBe('glm-5.2[1m]')
    // Presets must not pin a provider-wide auto-compact window: the env is
    // model-agnostic, so it pinned small-context models at 1M and auto-compact
    // never fired (#1162). Real windows come from modelContextWindows instead.
    expect(deepseek?.defaultEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(zhipu?.defaultEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(kimi?.baseUrl).toBe('https://api.kimi.com/coding/')
    expect(kimi?.regionalEndpoints).toBeUndefined()
    expect(kimi?.authStrategy).toBe('api_key')
    expect(kimi?.defaultModels.main).toBe('k3')
    expect(kimi?.defaultEnv?.CC_HAHA_SEND_DISABLED_THINKING).toBeUndefined()
    expect(kimi?.defaultEnv).toEqual({})
    expect(minimax?.baseUrl).toBe('https://api.minimaxi.com/anthropic')
    expect(minimax?.regionalEndpoints).toEqual([
      { region: 'cn_zh', baseUrl: 'https://api.minimaxi.com/anthropic' },
      { region: 'global_en', baseUrl: 'https://api.minimax.io/anthropic' },
    ])
    expect(minimax?.authStrategy).toBe('auth_token')
    expect(minimax?.defaultModels.main).toBe('MiniMax-M3[1m]')
    expect(minimax?.defaultEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(minimax?.defaultEnv).toEqual({})
    expect(minimax?.modelContextWindows?.['MiniMax-M3']).toBe(1000000)
    expect(shengsuanyun?.baseUrl).toBe('https://router.shengsuanyun.com/api')
    expect(shengsuanyun?.authStrategy).toBe('auth_token')
    expect(shengsuanyun?.defaultModels.main).toBe('anthropic/claude-sonnet-4.6')
    expect(shengsuanyun?.defaultModels.haiku).toBe('anthropic/claude-haiku-4.5:thinking')
    expect(shengsuanyun?.modelContextWindows?.['anthropic/claude-sonnet-4.6']).toBe(1000000)
    expect(teamorouter?.baseUrl).toBe('https://api.teamorouter.com')
    expect(teamorouter?.apiFormat).toBe('anthropic')
    expect(teamorouter?.authStrategy).toBe('auth_token')
    expect(teamorouter?.defaultModels.main).toBe('claude-opus-4-8')
    expect(teamorouter?.defaultModels.haiku).toBe('claude-haiku-4-5')
    expect(teamorouter?.defaultModels.sonnet).toBe('claude-sonnet-5')
    expect(teamorouter?.defaultModels.opus).toBe('claude-opus-4-8')
    expect(teamorouter?.modelContextWindows?.['claude-opus-4-8']).toBe(1000000)
    expect(atlascloud?.baseUrl).toBe('https://api.atlascloud.ai')
    expect(atlascloud?.apiFormat).toBe('openai_chat')
    expect(atlascloud?.authStrategy).toBe('api_key')
    expect(atlascloud?.defaultModels).toEqual({
      main: 'deepseek-ai/deepseek-v4-pro',
      haiku: 'deepseek-ai/deepseek-v4-pro',
      sonnet: 'deepseek-ai/deepseek-v4-pro',
      opus: 'deepseek-ai/deepseek-v4-pro',
    })
    expect(xuanshuapi?.baseUrl).toBe('https://www.xuanshuapi.com')
    expect(xuanshuapi?.apiFormat).toBe('anthropic')
    expect(xuanshuapi?.authStrategy).toBe('auth_token')
    expect(xuanshuapi?.defaultModels.main).toBe('claude-opus-5')
    expect(xuanshuapi?.defaultModels.haiku).toBe('claude-haiku-4-5')
    expect(xuanshuapi?.defaultModels.sonnet).toBe('claude-sonnet-5')
    expect(xuanshuapi?.defaultModels.opus).toBe('claude-opus-5')
    expect(xuanshuapi?.modelContextWindows?.['claude-opus-5']).toBe(1000000)
    // Both endpoints below are the Anthropic-compatible root: Claude Code appends
    // /v1/messages itself, so a /v1 or /anthropic suffix here would 404.
    expect(fennoai?.baseUrl).toBe('https://api.fenno.ai')
    expect(fennoai?.apiFormat).toBe('anthropic')
    expect(fennoai?.authStrategy).toBe('auth_token')
    expect(qiniuai?.baseUrl).toBe('https://api.qnaigc.com')
    expect(qiniuai?.apiFormat).toBe('anthropic')
    expect(qiniuai?.authStrategy).toBe('auth_token')
    // Both gateways front a catalog that shifts on their side, so the preset ships
    // no model ids: the user fetches the live list and picks. Pinning a default
    // here would hand out a model their plan may not even carry.
    for (const preset of [fennoai, qiniuai]) {
      expect(preset?.defaultModels).toEqual({ main: '', haiku: '', sonnet: '', opus: '' })
      // A pinned subagent model would reintroduce exactly that guess.
      expect(preset?.defaultEnv).toEqual({})
    }
    // The window table stays: it is keyed by model id, so it keeps paying off
    // once the user picks one — including ids the built-in table cannot resolve
    // (claude-opus-5, and every namespaced 七牛云 id).
    expect(fennoai?.modelContextWindows?.['claude-opus-5']).toBe(1000000)
    expect(qiniuai?.modelContextWindows?.['deepseek/deepseek-v4-pro']).toBe(1000000)
  })

  test('configured presets can expose optional API key and promo metadata', () => {
    const lmstudio = PROVIDER_PRESETS.find((preset) => preset.id === 'lmstudio')
    const ollama = PROVIDER_PRESETS.find((preset) => preset.id === 'ollama')
    const deepseek = PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek')
    const zhipu = PROVIDER_PRESETS.find((preset) => preset.id === 'zhipuglm')
    const kimi = PROVIDER_PRESETS.find((preset) => preset.id === 'kimi')
    const minimax = PROVIDER_PRESETS.find((preset) => preset.id === 'minimax')
    const shengsuanyun = PROVIDER_PRESETS.find((preset) => preset.id === 'shengsuanyun')
    const teamorouter = PROVIDER_PRESETS.find((preset) => preset.id === 'teamorouter')
    const xuanshuapi = PROVIDER_PRESETS.find((preset) => preset.id === 'xuanshuapi')
    const fennoai = PROVIDER_PRESETS.find((preset) => preset.id === 'fennoai')
    const qiniuai = PROVIDER_PRESETS.find((preset) => preset.id === 'qiniuai')
    const custom = PROVIDER_PRESETS.find((preset) => preset.id === 'custom')

    expect(lmstudio?.needsApiKey).toBe(false)
    expect(lmstudio?.promoText).toContain('http://localhost:1234')
    expect(lmstudio?.promoText).toContain('200K')
    expect(lmstudio?.defaultEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'lmstudio',
    })
    expect(ollama?.needsApiKey).toBe(false)
    expect(ollama?.promoText).toContain('http://localhost:11434')
    expect(ollama?.promoText).toContain('200K')
    expect(ollama?.defaultEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'ollama',
    })
    expect(deepseek?.apiKeyUrl).toBe('https://platform.deepseek.com/api_keys')
    expect(deepseek?.modelContextWindows?.['deepseek-v4-pro']).toBe(1000000)
    expect(deepseek?.modelContextWindows?.['deepseek-v4-flash']).toBe(1000000)
    expect(zhipu?.apiKeyUrl).toBe('https://www.bigmodel.cn/invite?icode=d41B2qi8Z5xNwTGLNPPF3OZLO2QH3C0EBTSr%2BArzMw4%3D')
    expect(zhipu?.promoText).toContain('cc-haha')
    expect(zhipu?.defaultEnv?.CC_HAHA_SEND_DISABLED_THINKING).toBeUndefined()
    expect(zhipu?.modelContextWindows?.['glm-5.2']).toBe(1000000)
    expect(zhipu?.modelContextWindows?.['glm-5.1']).toBe(200000)
    expect(zhipu?.modelContextWindows?.['glm-4.7']).toBe(200000)
    expect(zhipu?.modelContextWindows?.['glm-4.5-air']).toBe(128000)
    expect(kimi?.apiKeyUrl).toBe('https://www.kimi.com/code/console')
    expect(kimi?.modelContextWindows?.k3).toBe(262144)
    expect(kimi?.modelContextWindows?.['kimi-for-coding']).toBe(262144)
    expect(kimi?.modelContextWindows?.['kimi-for-coding-highspeed']).toBe(262144)
    expect(minimax?.apiKeyUrl).toBe('https://platform.minimaxi.com/subscribe/token-plan?code=1TG2Cseab2&source=link')
    // Retired: no referral link, no promo copy, no featured slot.
    expect(shengsuanyun?.apiKeyUrl).toBeUndefined()
    expect(shengsuanyun?.promoText).toBeUndefined()
    expect(shengsuanyun?.featured).toBeUndefined()
    expect(shengsuanyun?.defaultEnv).toEqual({
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
    expect(shengsuanyun?.modelContextWindows?.['anthropic/claude-opus-4.7']).toBe(1000000)
    expect(teamorouter?.apiKeyUrl).toBe(
      'https://teamorouter.com/?utm_source=cc_haha&utm_medium=referral&utm_campaign=ai_directory',
    )
    expect(teamorouter?.promoText).toContain('10% 折扣')
    expect(teamorouter?.featured).toBe(true)
    expect(teamorouter?.defaultEnv).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5',
    })
    expect(teamorouter?.modelContextWindows?.['claude-sonnet-5']).toBe(1000000)
    expect(xuanshuapi?.apiKeyUrl).toBe('https://www.xuanshuapi.com/register?aff=CC-HAHA&promo=CC-HAHA')
    expect(xuanshuapi?.promoText).toContain('5 美元')
    expect(xuanshuapi?.featured).toBe(true)
    expect(xuanshuapi?.defaultEnv).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5',
    })
    expect(xuanshuapi?.modelContextWindows?.['claude-sonnet-5']).toBe(1000000)
    expect(fennoai?.apiKeyUrl).toBe('https://api.fenno.ai/s/WD8c')
    expect(fennoai?.promoText).toContain('1.99 美元')
    expect(fennoai?.featured).toBe(true)
    expect(fennoai?.modelContextWindows?.['claude-sonnet-5']).toBe(1000000)
    expect(fennoai?.modelContextWindows?.['claude-haiku-4-5']).toBe(200000)
    expect(qiniuai?.apiKeyUrl).toBe('https://s.qiniu.com/IZbyya')
    expect(qiniuai?.promoText).toContain('Token')
    expect(qiniuai?.featured).toBe(true)
    expect(qiniuai?.modelContextWindows?.['deepseek/deepseek-v4-flash']).toBe(1000000)
    expect(qiniuai?.modelContextWindows?.['z-ai/glm-5.2']).toBe(1000000)
    expect(qiniuai?.modelContextWindows?.['moonshotai/kimi-k3']).toBe(262144)
    expect(custom?.promoText).toBeUndefined()
    expect(custom?.authStrategy).toBe('auth_token')
    expect(custom?.defaultEnv).toBeUndefined()
  })

  test('GET and PUT /api/providers/settings read and write cc-haha settings.json', async () => {
    const initial = {
      env: {
        ANTHROPIC_MODEL: 'glm-5.1',
      },
      model: 'glm-5.1',
    }
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'settings.json'),
      JSON.stringify(initial, null, 2),
      'utf-8',
    )

    const getReq = makeRequest('GET', '/api/providers/settings')
    const getRes = await handleProvidersApi(getReq.req, getReq.url, getReq.segments)
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual(initial)

    const updateBody = {
      model: 'kimi-k2.6',
      env: {
        ANTHROPIC_MODEL: 'kimi-k2.6',
      },
    }
    const putReq = makeRequest('PUT', '/api/providers/settings', updateBody)
    const putRes = await handleProvidersApi(putReq.req, putReq.url, putReq.segments)
    expect(putRes.status).toBe(200)

    const updatedRaw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')
    expect(JSON.parse(updatedRaw)).toEqual(updateBody)
  })

  test('retired presets keep the runtime config saved providers resolve from them', () => {
    for (const id of ['shengsuanyun', 'jiekouai']) {
      const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === id)

      expect(preset?.deprecated).toBe(true)
      // defaultEnv is never persisted per provider, so it can only come from here.
      expect(preset?.defaultEnv).toBeDefined()
      // Records saved before these fields existed fall back to the preset for them.
      expect(preset?.authStrategy).toBe('auth_token')
      expect(preset?.modelContextWindows).toBeDefined()
    }
  })

  test('retired 接口AI preset keeps runtime metadata without the obsolete Sonnet sentinel', () => {
    const jiekouai = PROVIDER_PRESETS.find((preset) => preset.id === 'jiekouai')

    // The shared capability resolver now emits the provider model capabilities.
    // Keeping the old `none` sentinel here would disable effort as well as thinking.
    expect(jiekouai?.defaultEnv).toEqual({})
    // Dropping this silently collapses the context window 1M -> 200k.
    expect(jiekouai?.modelContextWindows?.['claude-sonnet-4-6']).toBe(1000000)
    expect(jiekouai?.modelContextWindows?.['claude-opus-4-7']).toBe(1000000)
  })

  test('retired presets stop promoting themselves', () => {
    const retired = PROVIDER_PRESETS.filter((preset) => preset.deprecated)
    expect(retired.length).toBeGreaterThan(0)

    for (const preset of retired) {
      // The edit form renders apiKeyUrl/promoText from the resolved preset with no mode
      // guard, so a retired preset must not keep advertising itself to existing users.
      expect(preset.apiKeyUrl).toBeUndefined()
      expect(preset.promoText).toBeUndefined()
      expect(preset.featured).toBeUndefined()
    }
  })

  test('provider presets carry docs-backed context windows for current coding models', () => {
    const byId = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]))

    for (const id of ['deepseek', 'zhipuglm', 'kimi', 'minimax']) {
      const preset = byId.get(id)!
      expect(preset.modelContextWindows?.[preset.defaultModels.main]).toBeGreaterThan(0)
    }
  })
})
