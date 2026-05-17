import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  H5AccessService,
  resolveEffectiveH5PublicBaseUrl,
} from '../services/h5AccessService.js'
import { ProviderService } from '../services/providerService.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalH5PublicBaseUrl: string | undefined
let originalH5AutoPublicUrl: string | undefined

function getManagedSettingsPath(): string {
  return path.join(tmpDir, 'cc-haha', 'settings.json')
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'h5-access-service-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalH5PublicBaseUrl = process.env.CLAUDE_H5_PUBLIC_BASE_URL
  originalH5AutoPublicUrl = process.env.CLAUDE_H5_AUTO_PUBLIC_URL
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalH5PublicBaseUrl === undefined) delete process.env.CLAUDE_H5_PUBLIC_BASE_URL
  else process.env.CLAUDE_H5_PUBLIC_BASE_URL = originalH5PublicBaseUrl
  if (originalH5AutoPublicUrl === undefined) delete process.env.CLAUDE_H5_AUTO_PUBLIC_URL
  else process.env.CLAUDE_H5_AUTO_PUBLIC_URL = originalH5AutoPublicUrl
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('H5AccessService', () => {
  test('defaults to disabled state with sanitized settings', async () => {
    const service = new H5AccessService()

    await expect(service.getSettings()).resolves.toEqual({
      enabled: false,
      tokenPreview: null,
      allowedOrigins: [],
      publicBaseUrl: null,
    })

    await expect(service.validateToken('missing-token')).resolves.toBe(false)
  })

  test('enable generates a token and persists only hash plus preview', async () => {
    const service = new H5AccessService()

    const result = await service.enable()
    const raw = await fs.readFile(getManagedSettingsPath(), 'utf-8')
    const saved = JSON.parse(raw) as {
      h5Access: {
        enabled: boolean
        tokenHash: string
        tokenPreview: string
      }
    }

    expect(result.token).toMatch(/^h5_[A-Za-z0-9_-]{43}$/)
    expect(result.settings).toEqual({
      enabled: true,
      tokenPreview: saved.h5Access.tokenPreview,
      allowedOrigins: [],
      publicBaseUrl: null,
    })
    expect(saved.h5Access.enabled).toBe(true)
    expect(saved.h5Access.tokenHash).toHaveLength(64)
    expect(saved.h5Access.tokenPreview).toBe(
      `${result.token.slice(0, 7)}...${result.token.slice(-4)}`,
    )
    expect(raw).not.toContain(result.token)
    expect(await service.validateToken(result.token)).toBe(true)
  })

  test('enabled public settings use the packaged app LAN URL when provided', async () => {
    process.env.CLAUDE_H5_PUBLIC_BASE_URL = 'http://192.168.1.20:28670/'
    process.env.CLAUDE_H5_AUTO_PUBLIC_URL = '1'
    const service = new H5AccessService()

    const result = await service.enable()

    expect(result.settings.publicBaseUrl).toBe('http://192.168.1.20:28670')
  })

  test('configured public URL overrides stale stored local URLs', async () => {
    const service = new H5AccessService()
    await service.updateSettings({
      publicBaseUrl: 'http://192.168.0.102:5179',
    })

    process.env.CLAUDE_H5_PUBLIC_BASE_URL = 'https://chat.example.com/app/'
    const result = await service.enable()

    expect(result.settings.publicBaseUrl).toBe('https://chat.example.com/app')
  })

  test('auto LAN mode replaces stale local public URLs but keeps public reverse proxies', () => {
    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'http://192.168.0.102:5179',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.0.102:39876',
    })).toBe('http://192.168.0.102:39876')

    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'http://127.0.0.1:5179',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.0.102:39876',
    })).toBe('http://192.168.0.102:39876')

    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'https://chat.example.com/app',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.0.102:39876',
    })).toBe('https://chat.example.com/app')
  })

  test('regenerateToken invalidates the previous token', async () => {
    const service = new H5AccessService()

    const first = await service.enable()
    const second = await service.regenerateToken()

    expect(second.token).toMatch(/^h5_/)
    expect(second.token).not.toBe(first.token)
    expect(await service.validateToken(first.token)).toBe(false)
    expect(await service.validateToken(second.token)).toBe(true)
  })

  test('preserves unknown managed settings fields when updating h5Access', async () => {
    await fs.mkdir(path.dirname(getManagedSettingsPath()), { recursive: true })
    await fs.writeFile(
      getManagedSettingsPath(),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_MODEL: 'keep-me',
          },
          futureField: {
            keep: true,
          },
        },
        null,
        2,
      ),
      'utf-8',
    )

    const service = new H5AccessService()
    await service.enable()

    const saved = JSON.parse(await fs.readFile(getManagedSettingsPath(), 'utf-8')) as {
      env: {
        ANTHROPIC_MODEL: string
      }
      futureField: {
        keep: boolean
      }
      h5Access: unknown
    }

    expect(saved.env.ANTHROPIC_MODEL).toBe('keep-me')
    expect(saved.futureField).toEqual({ keep: true })
    expect(saved.h5Access).toBeDefined()
  })

  test('updateSettings normalizes origins and rejects invalid ones', async () => {
    const service = new H5AccessService()

    await expect(
      service.updateSettings({
        allowedOrigins: ['https://example.com/path', 'http://localhost:3000/foo'],
        publicBaseUrl: 'https://public.example.com/app/',
      }),
    ).resolves.toEqual({
      enabled: false,
      tokenPreview: null,
      allowedOrigins: ['https://example.com', 'http://localhost:3000'],
      publicBaseUrl: 'https://public.example.com/app',
    })

    await expect(
      service.updateSettings({
        allowedOrigins: ['https://*.example.com'],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  test('isOriginAllowed requires enabled state and matches normalized origins', async () => {
    const service = new H5AccessService()

    await service.updateSettings({
      allowedOrigins: ['https://example.com/path'],
    })

    await expect(service.isOriginAllowed('https://example.com')).resolves.toBe(false)

    await service.enable()

    await expect(service.isOriginAllowed('https://example.com')).resolves.toBe(true)
    await expect(service.isOriginAllowed('https://other.example.com')).resolves.toBe(false)
    await expect(service.isOriginAllowed('notaurl')).resolves.toBe(false)
  })

  test('malformed persisted enabled state without token hash is treated as disabled', async () => {
    await fs.mkdir(path.dirname(getManagedSettingsPath()), { recursive: true })
    await fs.writeFile(
      getManagedSettingsPath(),
      JSON.stringify({
        h5Access: {
          enabled: true,
          allowedOrigins: ['https://example.com/path'],
          publicBaseUrl: 'https://public.example.com',
        },
      }),
      'utf-8',
    )

    const service = new H5AccessService()

    await expect(service.getSettings()).resolves.toEqual({
      enabled: false,
      tokenPreview: null,
      allowedOrigins: ['https://example.com'],
      publicBaseUrl: 'https://public.example.com',
    })
    await expect(service.validateToken('anything')).resolves.toBe(false)
    await expect(service.isOriginAllowed('https://example.com')).resolves.toBe(false)
  })

  test('concurrent h5 enable and provider managed settings update preserve both fields', async () => {
    const h5Service = new H5AccessService()
    const providerService = new ProviderService()

    await Promise.all([
      h5Service.enable(),
      providerService.updateManagedSettings({
        env: {
          ANTHROPIC_MODEL: 'keep-me',
        },
      }),
    ])

    const saved = JSON.parse(await fs.readFile(getManagedSettingsPath(), 'utf-8')) as {
      env?: {
        ANTHROPIC_MODEL?: string
      }
      h5Access?: {
        enabled?: boolean
        tokenHash?: string | null
      }
    }

    expect(saved.env?.ANTHROPIC_MODEL).toBe('keep-me')
    expect(saved.h5Access?.enabled).toBe(true)
    expect(saved.h5Access?.tokenHash).toEqual(expect.any(String))
  })
})
