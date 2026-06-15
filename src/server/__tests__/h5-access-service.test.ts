import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  classifyH5PublicBaseUrl,
  collectLocalIPv4Hosts,
  findPrivateLanAddress,
  H5AccessService,
  resolveEffectiveH5PublicBaseUrl,
  validateH5PublicBaseUrl,
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
  delete process.env.CLAUDE_H5_AUTO_PUBLIC_URL
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
      token: null,
      tokenPreview: null,
      allowedOrigins: [],
      publicBaseUrl: null,
      fixedPort: null,
      disconnectGraceSeconds: null,
    })

    await expect(service.validateToken('missing-token')).resolves.toBe(false)
  })

  test('enable persists a recoverable token alongside hash and preview', async () => {
    const service = new H5AccessService()

    const result = await service.enable()
    const raw = await fs.readFile(getManagedSettingsPath(), 'utf-8')
    const saved = JSON.parse(raw) as {
      h5Access: {
        enabled: boolean
        token: string
        tokenHash: string
        tokenPreview: string
      }
    }

    expect(result.token).toMatch(/^h5_[A-Za-z0-9_-]{43}$/)
    expect(result.settings).toEqual({
      enabled: true,
      token: result.token,
      tokenPreview: saved.h5Access.tokenPreview,
      allowedOrigins: [],
      publicBaseUrl: null,
      fixedPort: null,
      disconnectGraceSeconds: null,
    })
    expect(saved.h5Access.enabled).toBe(true)
    // Plaintext is persisted on purpose (issue #767): the desktop app must be
    // able to re-display the QR code / token after a restart.
    expect(saved.h5Access.token).toBe(result.token)
    expect(saved.h5Access.tokenHash).toHaveLength(64)
    expect(saved.h5Access.tokenPreview).toBe(
      `${result.token.slice(0, 7)}...${result.token.slice(-4)}`,
    )
    expect(await service.validateToken(result.token)).toBe(true)
  })

  test('enable reuses the existing token instead of rotating it', async () => {
    const service = new H5AccessService()

    const first = await service.enable()
    const second = await service.enable()

    expect(second.token).toBe(first.token)
    expect(await service.validateToken(first.token)).toBe(true)
  })

  test('disable keeps the token so re-enable restores paired devices', async () => {
    const service = new H5AccessService()

    const first = await service.enable()
    const disabled = await service.disable()

    expect(disabled.enabled).toBe(false)
    expect(disabled.token).toBe(first.token)
    // Disabled state rejects every token even though it is still stored.
    expect(await service.validateToken(first.token)).toBe(false)

    const reEnabled = await service.enable()
    expect(reEnabled.token).toBe(first.token)
    expect(await service.validateToken(first.token)).toBe(true)
  })

  test('hand-edited plaintext token becomes the source of truth', async () => {
    await fs.mkdir(path.dirname(getManagedSettingsPath()), { recursive: true })
    await fs.writeFile(
      getManagedSettingsPath(),
      JSON.stringify({
        h5Access: {
          enabled: true,
          token: 'my-custom-pinned-token',
          tokenHash: 'f'.repeat(64),
          tokenPreview: 'stale-preview',
        },
      }),
      'utf-8',
    )

    const service = new H5AccessService()

    expect(await service.validateToken('my-custom-pinned-token')).toBe(true)
    const settings = await service.getSettings()
    expect(settings.enabled).toBe(true)
    expect(settings.token).toBe('my-custom-pinned-token')
    expect(settings.tokenPreview).toBe('my-cust...oken')
  })

  test('legacy hash-only settings stay enabled and validate by hash', async () => {
    const service = new H5AccessService()
    const result = await service.enable()

    // Simulate pre-#767 data: hash + preview persisted, plaintext missing.
    const saved = JSON.parse(await fs.readFile(getManagedSettingsPath(), 'utf-8')) as {
      h5Access: Record<string, unknown>
    }
    delete saved.h5Access.token
    await fs.writeFile(getManagedSettingsPath(), JSON.stringify(saved), 'utf-8')

    const legacyService = new H5AccessService()
    const settings = await legacyService.getSettings()
    expect(settings.enabled).toBe(true)
    expect(settings.token).toBeNull()
    expect(settings.tokenPreview).toBe(result.settings.tokenPreview)
    expect(await legacyService.validateToken(result.token)).toBe(true)
  })

  test('updateSettings manages fixedPort within the allowed range', async () => {
    const service = new H5AccessService()

    const updated = await service.updateSettings({ fixedPort: 28670 })
    expect(updated.fixedPort).toBe(28670)

    const saved = JSON.parse(await fs.readFile(getManagedSettingsPath(), 'utf-8')) as {
      h5Access: { fixedPort: number }
    }
    expect(saved.h5Access.fixedPort).toBe(28670)

    const cleared = await service.updateSettings({ fixedPort: null })
    expect(cleared.fixedPort).toBeNull()

    await expect(service.updateSettings({ fixedPort: 80 })).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(service.updateSettings({ fixedPort: 70000 })).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(service.updateSettings({ fixedPort: 3456.5 })).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  test('updateSettings manages the disconnect grace period within range', async () => {
    const service = new H5AccessService()

    // Default: no stored value falls back to the built-in 30s grace.
    await expect(service.getDisconnectGraceMs()).resolves.toBe(30_000)

    const updated = await service.updateSettings({ disconnectGraceSeconds: 600 })
    expect(updated.disconnectGraceSeconds).toBe(600)
    await expect(service.getDisconnectGraceMs()).resolves.toBe(600_000)

    const cleared = await service.updateSettings({ disconnectGraceSeconds: null })
    expect(cleared.disconnectGraceSeconds).toBeNull()
    await expect(service.getDisconnectGraceMs()).resolves.toBe(30_000)

    await expect(service.updateSettings({ disconnectGraceSeconds: 1 })).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(service.updateSettings({ disconnectGraceSeconds: 90_000 })).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(service.updateSettings({ disconnectGraceSeconds: 12.5 })).rejects.toMatchObject({
      statusCode: 400,
    })
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
    // Use loopback rather than a private-LAN IP so updateSettings's new
    // local-interface validation does not reject the fixture URL. The intent
    // here is still "stale stored URL overridden by configured" — loopback is
    // treated as a proxy URL by classifyH5PublicBaseUrl and accepted as-is.
    await service.updateSettings({
      publicBaseUrl: 'http://127.0.0.1:5179',
    })

    process.env.CLAUDE_H5_PUBLIC_BASE_URL = 'https://chat.example.com/app/'
    const result = await service.enable()

    expect(result.settings.publicBaseUrl).toBe('https://chat.example.com/app')
  })

  test('auto LAN mode fills blank or loopback URLs and refreshes manual LAN ports', () => {
    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: null,
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
      storedPublicBaseUrl: 'http://192.168.1.100:54064',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://172.20.16.1:39876',
    })).toBe('http://192.168.1.100:39876')

    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'https://chat.example.com/app',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.0.102:39876',
    })).toBe('https://chat.example.com/app')
  })

  test('auto LAN mode keeps full reverse proxy URLs intact', () => {
    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'https://192.168.1.100:8443',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.1.100:39876',
    })).toBe('https://192.168.1.100:8443')

    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'http://192.168.1.100:8080/h5',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.1.100:39876',
    })).toBe('http://192.168.1.100:8080/h5')
  })

  test('auto LAN detection prefers physical adapters over WSL and Docker virtual adapters', () => {
    expect(findPrivateLanAddress({
      'vEthernet (WSL)': [{
        address: '172.20.16.1',
        netmask: '255.255.240.0',
        family: 'IPv4',
        mac: '00:15:5d:00:00:01',
        internal: false,
        cidr: '172.20.16.1/20',
      }],
      'Docker Desktop': [{
        address: '172.17.0.1',
        netmask: '255.255.0.0',
        family: 'IPv4',
        mac: '02:42:ac:11:00:01',
        internal: false,
        cidr: '172.17.0.1/16',
      }],
      'Wi-Fi': [{
        address: '192.168.1.100',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
        cidr: '192.168.1.100/24',
      }],
    })).toBe('192.168.1.100')
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
      token: null,
      tokenPreview: null,
      allowedOrigins: ['https://example.com', 'http://localhost:3000'],
      publicBaseUrl: 'https://public.example.com/app',
      fixedPort: null,
      disconnectGraceSeconds: null,
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
      token: null,
      tokenPreview: null,
      allowedOrigins: ['https://example.com'],
      publicBaseUrl: 'https://public.example.com',
      fixedPort: null,
      disconnectGraceSeconds: null,
    })
    await expect(service.validateToken('anything')).resolves.toBe(false)
    await expect(service.isOriginAllowed('https://example.com')).resolves.toBe(false)
  })

  test('stale stored LAN host falls back to auto when not bound to any local interface', () => {
    // User saved 192.168.1.207 on a previous network; current interfaces only have 192.168.0.105.
    // Effective URL must hop over to the auto-discovered host:port.
    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'http://192.168.1.207:55379',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.0.105:55379',
      localInterfaceHosts: ['192.168.0.105'],
    })).toBe('http://192.168.0.105:55379')

    // When stored host IS on a local interface, keep refreshing only the port (existing behavior).
    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'http://192.168.1.100:5179',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.1.100:55379',
      localInterfaceHosts: ['192.168.1.100'],
    })).toBe('http://192.168.1.100:55379')

    // Reverse-proxy stored URLs are never replaced by auto fallback, even if host is unreachable.
    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'https://h5.mydomain.com',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.0.105:55379',
      localInterfaceHosts: ['192.168.0.105'],
    })).toBe('https://h5.mydomain.com')

    // Backward compat: without localInterfaceHosts the legacy port-refresh-only path still works.
    expect(resolveEffectiveH5PublicBaseUrl({
      enabled: true,
      storedPublicBaseUrl: 'http://192.168.1.207:5179',
      configuredPublicBaseUrl: null,
      autoPublicBaseUrl: 'http://192.168.0.105:55379',
    })).toBe('http://192.168.1.207:55379')
  })

  test('classifyH5PublicBaseUrl distinguishes plain LAN, proxy and invalid', () => {
    expect(classifyH5PublicBaseUrl('http://192.168.0.105:55379')).toBe('plain-lan')
    expect(classifyH5PublicBaseUrl('http://10.0.0.5:8080')).toBe('plain-lan')
    expect(classifyH5PublicBaseUrl('http://172.20.16.1:39876')).toBe('plain-lan')
    // proxy: https / custom path / hostname instead of IP
    expect(classifyH5PublicBaseUrl('https://h5.mydomain.com')).toBe('proxy')
    expect(classifyH5PublicBaseUrl('http://192.168.0.105:8080/h5')).toBe('proxy')
    expect(classifyH5PublicBaseUrl('https://192.168.0.105:8443')).toBe('proxy')
    expect(classifyH5PublicBaseUrl('http://my-tunnel:8443')).toBe('proxy')
    // invalid
    expect(classifyH5PublicBaseUrl('not a url')).toBe('invalid')
    expect(classifyH5PublicBaseUrl('ftp://example.com')).toBe('invalid')
    expect(classifyH5PublicBaseUrl('http://user:pass@example.com')).toBe('invalid')
  })

  test('validateH5PublicBaseUrl: plain LAN host must be on local interfaces', () => {
    const localHosts = ['192.168.0.105']

    expect(validateH5PublicBaseUrl('http://192.168.0.105:55379', localHosts)).toEqual({
      ok: true,
      kind: 'plain-lan',
    })

    const stale = validateH5PublicBaseUrl('http://192.168.1.207:55379', localHosts)
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.reason).toContain('192.168.1.207')
      expect(stale.reason).toContain('192.168.0.105')
      expect(stale.suggestedHost).toBe('192.168.0.105')
    }
  })

  test('validateH5PublicBaseUrl: proxy URLs are accepted without local-interface checks', () => {
    expect(validateH5PublicBaseUrl('https://h5.mydomain.com', ['192.168.0.105'])).toEqual({
      ok: true,
      kind: 'proxy',
    })
    expect(validateH5PublicBaseUrl('http://192.168.0.105:8080/h5', ['10.0.0.5'])).toEqual({
      ok: true,
      kind: 'proxy',
    })
  })

  test('validateH5PublicBaseUrl: invalid URLs are rejected with suggested host', () => {
    const result = validateH5PublicBaseUrl('ftp://example.com', ['192.168.0.105'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.suggestedHost).toBe('192.168.0.105')
    }
  })

  test('updateSettings rejects a stale LAN host', async () => {
    const service = new H5AccessService()
    // Pick a private-LAN IP that is virtually guaranteed not to be on the
    // test machine's interfaces (192.168.255.0/24 is reserved-ish in practice
    // and we never see it in CI / dev environments).
    await expect(
      service.updateSettings({
        publicBaseUrl: 'http://192.168.255.254:55379',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  test('collectLocalIPv4Hosts returns only non-internal IPv4 hosts', () => {
    expect(collectLocalIPv4Hosts({
      lo: [{
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      }],
      'Wi-Fi': [{
        address: '192.168.0.105',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
        cidr: '192.168.0.105/24',
      }, {
        address: 'fe80::1',
        netmask: 'ffff:ffff:ffff:ffff::',
        family: 'IPv6',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
        scopeid: 0,
        cidr: 'fe80::1/64',
      }],
    })).toEqual(['192.168.0.105'])
  })

  test('getDiagnostics reports stale, ok, proxy and unset states', async () => {
    const service = new H5AccessService()

    // unset: no stored URL
    let diag = await service.getDiagnostics()
    expect(diag.storedHostStaleness).toBe('unset')
    expect(diag.storedPublicBaseUrl).toBeNull()
    expect(Array.isArray(diag.localInterfaceHosts)).toBe(true)

    // proxy stored URL
    await service.updateSettings({ publicBaseUrl: 'https://h5.mydomain.com' })
    diag = await service.getDiagnostics()
    expect(diag.storedHostStaleness).toBe('proxy')
    expect(diag.storedPublicBaseUrl).toBe('https://h5.mydomain.com')

    // ok: stored URL host is on local interfaces
    const localHost = collectLocalIPv4Hosts()[0]
    if (localHost) {
      await service.updateSettings({ publicBaseUrl: `http://${localHost}:55379` })
      diag = await service.getDiagnostics()
      expect(diag.storedHostStaleness).toBe('ok')
    }
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
