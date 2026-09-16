import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
  MAX_AI_REQUEST_TIMEOUT_MS,
  MIN_AI_REQUEST_TIMEOUT_MS,
  SYSTEM_PROXY_ERROR_ENV,
  SYSTEM_PROXY_URL_ENV,
  getManualNetworkProxyUrl,
  buildNetworkEnvironment,
  getNetworkProxyFetchOptions,
  getNetworkProxyUrl,
  loadNetworkSettings,
  normalizeNetworkSettings,
} from '../services/networkSettings.js'
import { SettingsService } from '../services/settingsService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let tmpDir: string
let originalConfigDir: string | undefined
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  SYSTEM_PROXY_URL_ENV,
  SYSTEM_PROXY_ERROR_ENV,
] as const
let originalProxyEnv: Partial<Record<typeof PROXY_ENV_KEYS[number], string>>

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'network-settings-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalProxyEnv = {}
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key] !== undefined) originalProxyEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  for (const key of PROXY_ENV_KEYS) {
    const originalValue = originalProxyEnv[key]
    if (originalValue === undefined) delete process.env[key]
    else process.env[key] = originalValue
  }
  resetSettingsCache()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe('network settings', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('normalizes missing and legacy-invalid settings to the 1800s system-proxy default', () => {
    expect(DEFAULT_AI_REQUEST_TIMEOUT_MS).toBe(1_800_000)
    expect(normalizeNetworkSettings({})).toEqual({
      aiRequestTimeoutMs: DEFAULT_AI_REQUEST_TIMEOUT_MS,
      proxy: {
        mode: 'system',
        url: '',
      },
    })
    expect(normalizeNetworkSettings({
      network: { proxy: { mode: 'legacy', url: 'http://stale.example:8080' } },
    }).proxy).toEqual({
      mode: 'system',
      url: '',
    })
  })

  it('preserves explicit direct mode and clears inherited HTTP, HTTPS, and ALL proxy environment', () => {
    const settings = normalizeNetworkSettings({
      network: {
        proxy: {
          mode: 'direct',
          url: '',
        },
      },
    })

    expect(buildNetworkEnvironment(settings, {
      HTTP_PROXY: 'http://127.0.0.1:1181',
      HTTPS_PROXY: 'http://127.0.0.1:1181',
      http_proxy: 'http://127.0.0.1:1181',
      https_proxy: 'http://127.0.0.1:1181',
      ALL_PROXY: 'socks5://127.0.0.1:1182',
      all_proxy: 'socks5://127.0.0.1:1182',
    })).toMatchObject({
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
    })
    expect(getNetworkProxyUrl(settings, {
      [SYSTEM_PROXY_URL_ENV]: 'http://127.0.0.1:1183',
    })).toBeNull()
    process.env.HTTP_PROXY = 'http://127.0.0.1:1181'
    expect(getNetworkProxyFetchOptions(settings, 'https://api.example.com/v1/messages').proxy).toBeUndefined()
  })

  it('uses only the explicit system-proxy bridge for system provider requests', () => {
    const settings = normalizeNetworkSettings({
      network: {
        proxy: {
          mode: 'system',
          url: '',
        },
      },
    })

    const bridgeUrl = 'http://127.0.0.1:1183'
    const baseEnv = {
      HTTP_PROXY: 'http://inherited.example:8080',
      ALL_PROXY: 'socks5://inherited.example:1080',
      NO_PROXY: '.corp.local',
      [SYSTEM_PROXY_URL_ENV]: `  ${bridgeUrl}  `,
    }
    expect(getNetworkProxyUrl(settings, baseEnv)).toBe(bridgeUrl)
    expect(buildNetworkEnvironment(settings, baseEnv)).toEqual({
      API_TIMEOUT_MS: String(DEFAULT_AI_REQUEST_TIMEOUT_MS),
      HTTP_PROXY: bridgeUrl,
      HTTPS_PROXY: bridgeUrl,
      http_proxy: bridgeUrl,
      https_proxy: bridgeUrl,
      ALL_PROXY: bridgeUrl,
      all_proxy: bridgeUrl,
      NO_PROXY: '.corp.local,localhost,127.0.0.1,::1',
      no_proxy: '.corp.local,localhost,127.0.0.1,::1',
    })

    process.env.HTTP_PROXY = 'http://inherited.example:8080'
    process.env[SYSTEM_PROXY_URL_ENV] = bridgeUrl
    expect(getNetworkProxyFetchOptions(settings, 'https://api.example.com/v1/messages').proxy)
      .toBe(bridgeUrl)
  })

  it('uses inherited process proxy for non-Electron system-mode servers', () => {
    const settings = normalizeNetworkSettings({
      network: { proxy: { mode: 'system', url: '' } },
    })
    process.env.HTTP_PROXY = 'http://inherited.example:8080'

    expect(getNetworkProxyUrl(settings)).toBe('http://inherited.example:8080')
    expect(buildNetworkEnvironment(settings, process.env)).toMatchObject({
      HTTP_PROXY: 'http://inherited.example:8080',
      HTTPS_PROXY: 'http://inherited.example:8080',
      http_proxy: 'http://inherited.example:8080',
      https_proxy: 'http://inherited.example:8080',
      ALL_PROXY: 'http://inherited.example:8080',
      all_proxy: 'http://inherited.example:8080',
    })
    expect(getNetworkProxyFetchOptions(settings, 'https://api.example.com/v1/messages').proxy)
      .toBe('http://inherited.example:8080')
  })

  it('surfaces a host bridge startup failure instead of silently going direct', () => {
    const settings = normalizeNetworkSettings({
      network: { proxy: { mode: 'system', url: '' } },
    })
    const env = {
      [SYSTEM_PROXY_ERROR_ENV]: 'local bridge could not bind',
    }

    expect(() => getNetworkProxyUrl(settings, env))
      .toThrow('local bridge could not bind')
    expect(() => buildNetworkEnvironment(settings, env))
      .toThrow('local bridge could not bind')

    expect(getNetworkProxyUrl(normalizeNetworkSettings({
      network: { proxy: { mode: 'direct', url: '' } },
    }), env)).toBeNull()
    expect(getNetworkProxyUrl(normalizeNetworkSettings({
      network: { proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } },
    }), env)).toBe('http://127.0.0.1:7890')
  })

  it('clamps AI request timeouts and trims manual proxy URLs', () => {
    expect(normalizeNetworkSettings({
      network: {
        aiRequestTimeoutMs: Number.MAX_SAFE_INTEGER,
        proxy: {
          mode: 'manual',
          url: '  http://127.0.0.1:7890  ',
        },
      },
    })).toEqual({
      aiRequestTimeoutMs: MAX_AI_REQUEST_TIMEOUT_MS,
      proxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })

    expect(normalizeNetworkSettings({
      network: {
        aiRequestTimeoutMs: 100,
      },
    }).aiRequestTimeoutMs).toBe(MIN_AI_REQUEST_TIMEOUT_MS)
  })

  it.each([14_400_000, 21_600_000, 2_147_483_000])('preserves a long request budget through save, reload, and provider environment (%i ms)', async timeoutMs => {
    const service = new SettingsService()
    await service.updateUserSettings({ network: { aiRequestTimeoutMs: timeoutMs } })
    const settings = await loadNetworkSettings()

    expect(settings.aiRequestTimeoutMs).toBe(timeoutMs)
    expect(buildNetworkEnvironment(settings).API_TIMEOUT_MS).toBe(String(timeoutMs))
  })

  it('caps only at the largest whole-second budget that does not overflow JavaScript timers', () => {
    expect(MAX_AI_REQUEST_TIMEOUT_MS).toBe(2_147_483_000)
    expect(normalizeNetworkSettings({
      network: { aiRequestTimeoutMs: 2_147_483_648 },
    }).aiRequestTimeoutMs).toBe(2_147_483_000)
  })

  it('loads persisted user network settings for provider requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 180_000,
          proxy: {
            mode: 'manual',
            url: ' http://127.0.0.1:7890 ',
          },
        },
      }),
      'utf-8',
    )

    const settings = await loadNetworkSettings()

    expect(settings.aiRequestTimeoutMs).toBe(180_000)
    expect(getManualNetworkProxyUrl(settings)).toBe('http://127.0.0.1:7890')
    expect(buildNetworkEnvironment(settings)).toEqual({
      API_TIMEOUT_MS: '180000',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      ALL_PROXY: 'http://127.0.0.1:7890',
      all_proxy: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    })
  })

  it('preserves custom no_proxy entries while adding loopback bypasses for manual proxies', () => {
    const settings = normalizeNetworkSettings({
      network: {
        proxy: {
          mode: 'manual',
          url: 'http://proxy.example:8080',
        },
      },
    })

    expect(buildNetworkEnvironment(settings, { no_proxy: '.corp.local,10.0.0.0/8' })).toMatchObject({
      NO_PROXY: '.corp.local,10.0.0.0/8,localhost,127.0.0.1,::1',
      no_proxy: '.corp.local,10.0.0.0/8,localhost,127.0.0.1,::1',
    })
  })

  it('preserves authenticated manual proxy URLs for provider requests', () => {
    const settings = normalizeNetworkSettings({
      network: {
        proxy: {
          mode: 'manual',
          url: ' https://user:p%40ss@proxy.example.com:8443 ',
        },
      },
    })

    expect(getManualNetworkProxyUrl(settings)).toBe('https://user:p%40ss@proxy.example.com:8443')
    expect(getNetworkProxyUrl(settings, {
      [SYSTEM_PROXY_URL_ENV]: 'http://system.example:8080',
    })).toBe('https://user:p%40ss@proxy.example.com:8443')
    expect(buildNetworkEnvironment(settings)).toMatchObject({
      HTTP_PROXY: 'https://user:p%40ss@proxy.example.com:8443',
      HTTPS_PROXY: 'https://user:p%40ss@proxy.example.com:8443',
      ALL_PROXY: 'https://user:p%40ss@proxy.example.com:8443',
      all_proxy: 'https://user:p%40ss@proxy.example.com:8443',
    })
    process.env.HTTP_PROXY = 'http://inherited.example:8080'
    process.env[SYSTEM_PROXY_URL_ENV] = 'http://system.example:8080'
    expect(getNetworkProxyFetchOptions(settings, 'https://api.example.com/v1/messages').proxy)
      .toBe('https://user:p%40ss@proxy.example.com:8443')
  })

  it('fails closed to direct when a corrupted manual setting has no URL', () => {
    const settings = normalizeNetworkSettings({
      network: { proxy: { mode: 'manual', url: '   ' } },
    })

    expect(getNetworkProxyUrl(settings)).toBeNull()
    expect(buildNetworkEnvironment(settings, {
      HTTP_PROXY: 'http://inherited.example:8080',
      ALL_PROXY: 'socks5://inherited.example:1080',
    })).toMatchObject({
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
    })
  })
})
