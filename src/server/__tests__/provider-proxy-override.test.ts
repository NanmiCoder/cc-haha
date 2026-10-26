/**
 * Unit tests for the per-provider network proxy override.
 *
 * Covers resolveProviderNetworkSettings semantics, persistence through
 * ProviderService CRUD, and load-time normalization of the providers index.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ProviderService } from '../services/providerService.js'
import {
  buildNetworkEnvironment,
  resolveProviderNetworkSettings,
} from '../services/networkSettings.js'
import {
  normalizeProviderProxyConfig,
  normalizeSavedProvider,
} from '../services/providerRuntimeEnv.js'
import type { CreateProviderInput, SavedProvider } from '../types/provider.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-proxy-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
}

function sampleInput(overrides?: Partial<CreateProviderInput>): CreateProviderInput {
  return {
    presetId: 'custom',
    name: 'Proxy Test Provider',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-proxy-test',
    apiFormat: 'openai_chat',
    models: { main: 'model-main', haiku: 'model-haiku', sonnet: 'model-sonnet', opus: 'model-opus' },
    ...overrides,
  }
}

const GLOBAL_MANUAL = {
  aiRequestTimeoutMs: 600_000,
  proxy: { mode: 'manual' as const, url: 'http://global-proxy.example:7890' },
}

describe('per-provider proxy override', () => {
  beforeEach(setup)
  afterEach(teardown)

  describe('resolveProviderNetworkSettings', () => {
    test('keeps global settings when the override is absent', () => {
      expect(resolveProviderNetworkSettings(GLOBAL_MANUAL, undefined)).toBe(GLOBAL_MANUAL)
      expect(resolveProviderNetworkSettings(GLOBAL_MANUAL, null)).toBe(GLOBAL_MANUAL)
    })

    test('keeps global settings for follow_global', () => {
      expect(resolveProviderNetworkSettings(GLOBAL_MANUAL, { mode: 'follow_global' })).toBe(GLOBAL_MANUAL)
    })

    test('direct override pins the provider to a direct connection', () => {
      const resolved = resolveProviderNetworkSettings(GLOBAL_MANUAL, { mode: 'direct' })
      expect(resolved.proxy).toEqual({ mode: 'direct', url: '' })
      // Timeout stays global.
      expect(resolved.aiRequestTimeoutMs).toBe(GLOBAL_MANUAL.aiRequestTimeoutMs)
      expect(buildNetworkEnvironment(resolved).HTTPS_PROXY).toBe('')
    })

    test('manual override routes through the provider URL', () => {
      const resolved = resolveProviderNetworkSettings(GLOBAL_MANUAL, {
        mode: 'manual',
        url: 'http://per-provider.example:1080',
      })
      expect(resolved.proxy).toEqual({ mode: 'manual', url: 'http://per-provider.example:1080' })
      expect(buildNetworkEnvironment(resolved).HTTPS_PROXY).toBe('http://per-provider.example:1080')
    })

    test('manual override without a URL degrades to the global settings', () => {
      // Hand-written indexes may carry a malformed manual entry; loading must
      // not silently reroute such a provider through the global proxy *labelled*
      // as manual — resolveProviderNetworkSettings treats it as follow_global.
      expect(resolveProviderNetworkSettings(GLOBAL_MANUAL, { mode: 'manual' })).toBe(GLOBAL_MANUAL)
    })
  })

  describe('normalizeProviderProxyConfig', () => {
    test('drops invalid shapes', () => {
      expect(normalizeProviderProxyConfig(undefined)).toBeUndefined()
      expect(normalizeProviderProxyConfig('manual')).toBeUndefined()
      expect(normalizeProviderProxyConfig({ mode: 'bogus' })).toBeUndefined()
      expect(normalizeProviderProxyConfig({ mode: 'manual', url: '' })).toBeUndefined()
    })

    test('normalizes follow_global and direct without a URL', () => {
      expect(normalizeProviderProxyConfig({ mode: 'follow_global', url: 'ignored' }))
        .toEqual({ mode: 'follow_global' })
      expect(normalizeProviderProxyConfig({ mode: 'direct' })).toEqual({ mode: 'direct' })
    })

    test('keeps a valid manual override and trims its URL', () => {
      expect(normalizeProviderProxyConfig({ mode: 'manual', url: '  http://p.example:1  ' }))
        .toEqual({ mode: 'manual', url: 'http://p.example:1' })
    })
  })

  describe('saved provider persistence', () => {
    test('addProvider persists the proxy override', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput({
        proxy: { mode: 'direct' },
      }))
      expect(provider.proxy).toEqual({ mode: 'direct' })

      const stored = await svc.getProvider(provider.id)
      expect(stored.proxy).toEqual({ mode: 'direct' })
    })

    test('updateProvider updates and clears the override', async () => {
      const svc = new ProviderService()
      const provider = await svc.addProvider(sampleInput())

      const updated = await svc.updateProvider(provider.id, {
        proxy: { mode: 'manual', url: 'http://provider-proxy.example:8080' },
      })
      expect(updated.proxy).toEqual({ mode: 'manual', url: 'http://provider-proxy.example:8080' })

      const cleared = await svc.updateProvider(provider.id, { proxy: null })
      expect(cleared.proxy).toBeUndefined()
    })

    test('built-in official providers never carry an override', async () => {
      const svc = new ProviderService()
      const { providers } = await svc.listProviders()
      expect(providers.every((p) => (p as SavedProvider).proxy === undefined)).toBe(true)
    })
  })

  describe('providers index normalization', () => {
    test('a legacy index without proxy fields loads unchanged', async () => {
      const ccHahaDir = path.join(tmpDir, 'cc-haha')
      await fs.mkdir(ccHahaDir, { recursive: true })
      const legacy = {
        schemaVersion: 8,
        activeId: 'legacy-provider',
        providers: [{
          id: 'legacy-provider',
          presetId: 'custom',
          name: 'Legacy',
          apiKey: 'k',
          baseUrl: 'https://legacy.example.com',
          apiFormat: 'openai_chat',
          models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
        }],
        providerOrder: ['legacy-provider'],
      }
      await fs.writeFile(path.join(ccHahaDir, 'providers.json'), JSON.stringify(legacy))

      const svc = new ProviderService()
      const provider = await svc.getProvider('legacy-provider')
      expect(provider.proxy).toBeUndefined()
      expect(provider.name).toBe('Legacy')
    })

    test('normalizeSavedProvider keeps a valid override and drops a malformed one', () => {
      const base: SavedProvider = {
        id: 'p1', presetId: 'custom', name: 'P', apiKey: 'k',
        baseUrl: 'https://example.com', apiFormat: 'openai_chat',
        models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
      }
      expect(normalizeSavedProvider({ ...base, proxy: { mode: 'direct' } }).proxy)
        .toEqual({ mode: 'direct' })
      expect(normalizeSavedProvider({ ...base, proxy: { mode: 'manual' } }).proxy)
        .toBeUndefined()
    })
  })
})
