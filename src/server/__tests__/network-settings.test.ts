import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
  MAX_AI_REQUEST_TIMEOUT_MS,
  MIN_AI_REQUEST_TIMEOUT_MS,
  getManualNetworkProxyUrl,
  buildNetworkEnvironment,
  loadNetworkSettings,
  normalizeNetworkSettings,
} from '../services/networkSettings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'network-settings-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  resetSettingsCache()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe('network settings', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('normalizes missing settings to the 120s system-proxy default', () => {
    expect(normalizeNetworkSettings({})).toEqual({
      aiRequestTimeoutMs: DEFAULT_AI_REQUEST_TIMEOUT_MS,
      proxy: {
        mode: 'system',
        url: '',
      },
    })
  })

  it('clamps AI request timeouts and trims manual proxy URLs', () => {
    expect(normalizeNetworkSettings({
      network: {
        aiRequestTimeoutMs: 999_999,
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
    expect(buildNetworkEnvironment(settings)).toMatchObject({
      HTTP_PROXY: 'https://user:p%40ss@proxy.example.com:8443',
      HTTPS_PROXY: 'https://user:p%40ss@proxy.example.com:8443',
    })
  })
})
