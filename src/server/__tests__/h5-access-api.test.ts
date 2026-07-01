import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'
import { resetRuntimeTunnelState } from '../services/h5AccessService.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalH5TunnelUrl: string | undefined

async function api(
  method: string,
  pathname: string,
  options: {
    body?: Record<string, unknown>
    bearerToken?: string
  } = {},
): Promise<Response> {
  const url = new URL(pathname, 'http://localhost:3456')
  const headers: Record<string, string> = {}

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (options.bearerToken) {
    headers.Authorization = `Bearer ${options.bearerToken}`
  }

  return handleApiRequest(
    new Request(url.toString(), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    url,
  )
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'h5-access-api-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalH5TunnelUrl = process.env.CLAUDE_H5_TUNNEL_URL
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  delete process.env.CLAUDE_H5_TUNNEL_URL
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalH5TunnelUrl === undefined) delete process.env.CLAUDE_H5_TUNNEL_URL
  else process.env.CLAUDE_H5_TUNNEL_URL = originalH5TunnelUrl
  resetRuntimeTunnelState()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('/api/h5-access', () => {
  test('GET returns sanitized disabled status by default', async () => {
    const response = await api('GET', '/api/h5-access')

    expect(response.status).toBe(200)
    const body = await response.json() as {
      settings: unknown
      diagnostics?: {
        storedHostStaleness: string
        storedPublicBaseUrl: string | null
        effectivePublicBaseUrl: string | null
        suggestedHost: string | null
        localInterfaceHosts: string[]
      }
    }
    expect(body.settings).toEqual({
      enabled: false,
      token: null,
      tokenPreview: null,
      allowedOrigins: [],
      publicBaseUrl: null,
      fixedPort: null,
      disconnectGraceSeconds: null,
    })
    expect(body.diagnostics).toBeDefined()
    expect(body.diagnostics?.storedHostStaleness).toBe('unset')
    expect(body.diagnostics?.storedPublicBaseUrl).toBeNull()
    expect(Array.isArray(body.diagnostics?.localInterfaceHosts)).toBe(true)
  })

  test('enable returns the token and GET keeps it recoverable', async () => {
    const enableResponse = await api('POST', '/api/h5-access/enable')
    expect(enableResponse.status).toBe(200)

    const enablePayload = await enableResponse.json() as {
      settings: {
        enabled: boolean
        tokenPreview: string
      }
      token: string
    }

    expect(enablePayload.settings.enabled).toBe(true)
    expect(enablePayload.token).toMatch(/^h5_/)

    // GET /api/h5-access is local-trusted-only (remote callers are rejected
    // upstream), so the desktop app can recover the full token at any time.
    const statusResponse = await api('GET', '/api/h5-access')
    expect(statusResponse.status).toBe(200)
    const statusPayload = await statusResponse.json() as {
      settings: {
        enabled: boolean
        token: string | null
        tokenPreview: string | null
      }
    }

    expect(statusPayload.settings.enabled).toBe(true)
    expect(statusPayload.settings.tokenPreview).toBe(enablePayload.settings.tokenPreview)
    expect(statusPayload.settings.token).toBe(enablePayload.token)
  })

  test('verify accepts a good bearer token and rejects missing or bad tokens', async () => {
    const enableResponse = await api('POST', '/api/h5-access/enable')
    const enablePayload = await enableResponse.json() as { token: string }

    expect(
      await api('POST', '/api/h5-access/verify', { bearerToken: enablePayload.token }),
    ).toMatchObject({ status: 200 })
    expect(await api('POST', '/api/h5-access/verify')).toMatchObject({ status: 401 })
    expect(
      await api('POST', '/api/h5-access/verify', { bearerToken: 'bad-token' }),
    ).toMatchObject({ status: 401 })
  })

  test('regenerate returns a new token and invalidates the previous one', async () => {
    const enableResponse = await api('POST', '/api/h5-access/enable')
    const enablePayload = await enableResponse.json() as { token: string }

    const regenerateResponse = await api('POST', '/api/h5-access/regenerate')
    expect(regenerateResponse.status).toBe(200)
    const regeneratePayload = await regenerateResponse.json() as {
      settings: {
        enabled: boolean
      }
      token: string
    }

    expect(regeneratePayload.settings.enabled).toBe(true)
    expect(regeneratePayload.token).toMatch(/^h5_/)
    expect(regeneratePayload.token).not.toBe(enablePayload.token)
    expect(
      await api('POST', '/api/h5-access/verify', { bearerToken: enablePayload.token }),
    ).toMatchObject({ status: 401 })
    expect(
      await api('POST', '/api/h5-access/verify', { bearerToken: regeneratePayload.token }),
    ).toMatchObject({ status: 200 })
  })

  test('disable blocks access but keeps the token for a later re-enable', async () => {
    const enableResponse = await api('POST', '/api/h5-access/enable')
    const enablePayload = await enableResponse.json() as {
      settings: { tokenPreview: string }
      token: string
    }

    const disableResponse = await api('POST', '/api/h5-access/disable')
    expect(disableResponse.status).toBe(200)
    await expect(disableResponse.json()).resolves.toEqual({
      settings: {
        enabled: false,
        token: enablePayload.token,
        tokenPreview: enablePayload.settings.tokenPreview,
        allowedOrigins: [],
        publicBaseUrl: null,
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })

    expect(
      await api('POST', '/api/h5-access/verify', { bearerToken: enablePayload.token }),
    ).toMatchObject({ status: 401 })

    const reEnableResponse = await api('POST', '/api/h5-access/enable')
    const reEnablePayload = await reEnableResponse.json() as { token: string }
    expect(reEnablePayload.token).toBe(enablePayload.token)
    expect(
      await api('POST', '/api/h5-access/verify', { bearerToken: enablePayload.token }),
    ).toMatchObject({ status: 200 })
  })

  test('PUT updates sanitized settings', async () => {
    const response = await api('PUT', '/api/h5-access', {
      body: {
        allowedOrigins: ['https://example.com/path'],
        publicBaseUrl: 'https://public.example.com/app/',
        fixedPort: 28670,
        disconnectGraceSeconds: null,
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      settings: {
        enabled: false,
        token: null,
        tokenPreview: null,
        allowedOrigins: ['https://example.com'],
        publicBaseUrl: 'https://public.example.com/app',
        fixedPort: 28670,
        disconnectGraceSeconds: null,
      },
    })
  })

  test('PUT rejects out-of-range fixedPort', async () => {
    const response = await api('PUT', '/api/h5-access', {
      body: { fixedPort: 80 },
    })

    expect(response.status).toBe(400)
  })

  test('GET surfaces a runtime tunnel URL as the effective publicBaseUrl', async () => {
    // The tunnel URL is a runtime override, never persisted. Enabling H5 access
    // should make GET report it so the desktop UI / QR reflect the public entry.
    await api('POST', '/api/h5-access/enable')
    process.env.CLAUDE_H5_TUNNEL_URL = 'https://abcd-1234.ngrok-free.app/h5/'

    const response = await api('GET', '/api/h5-access')
    expect(response.status).toBe(200)
    const body = await response.json() as {
      settings: { publicBaseUrl: string | null }
    }
    expect(body.settings.publicBaseUrl).toBe('https://abcd-1234.ngrok-free.app/h5')
  })

  test('tunnel/report sets the runtime tunnel URL and reflects it in settings', async () => {
    await api('POST', '/api/h5-access/enable')

    const reportResponse = await api('POST', '/api/h5-access/tunnel/report', {
      body: { url: 'https://abcd.trycloudflare.com', status: 'running', mode: 'quick' },
    })
    expect(reportResponse.status).toBe(200)
    const reportBody = await reportResponse.json() as {
      settings: { publicBaseUrl: string | null }
      tunnel: { status: string; url: string | null; mode: string | null }
    }
    expect(reportBody.tunnel.status).toBe('running')
    expect(reportBody.tunnel.url).toBe('https://abcd.trycloudflare.com')
    expect(reportBody.tunnel.mode).toBe('quick')
    expect(reportBody.settings.publicBaseUrl).toBe('https://abcd.trycloudflare.com')

    const statusResponse = await api('GET', '/api/h5-access/tunnel')
    expect(statusResponse.status).toBe(200)
    await expect(statusResponse.json()).resolves.toMatchObject({
      tunnel: { status: 'running', url: 'https://abcd.trycloudflare.com' },
    })
  })

  test('tunnel/report status-only heartbeat does not clear a running URL', async () => {
    await api('POST', '/api/h5-access/enable')
    await api('POST', '/api/h5-access/tunnel/report', {
      body: { url: 'https://abcd.trycloudflare.com', status: 'running', mode: 'quick' },
    })

    // A heartbeat with no url field (and an empty-string url) must preserve the URL.
    await api('POST', '/api/h5-access/tunnel/report', { body: { status: 'running' } })
    const emptyResponse = await api('POST', '/api/h5-access/tunnel/report', {
      body: { url: '', status: 'running' },
    })
    const body = await emptyResponse.json() as { tunnel: { url: string | null } }
    expect(body.tunnel.url).toBe('https://abcd.trycloudflare.com')
  })

  test('tunnel/clear resets the runtime tunnel and falls back to stored URL', async () => {    await api('PUT', '/api/h5-access', { body: { publicBaseUrl: 'https://chat.example.com/app' } })
    await api('POST', '/api/h5-access/enable')
    await api('POST', '/api/h5-access/tunnel/report', {
      body: { url: 'https://abcd.trycloudflare.com', status: 'running', mode: 'quick' },
    })

    const clearResponse = await api('POST', '/api/h5-access/tunnel/clear')
    expect(clearResponse.status).toBe(200)
    const clearBody = await clearResponse.json() as {
      settings: { publicBaseUrl: string | null }
      tunnel: { status: string; url: string | null }
    }
    expect(clearBody.tunnel.status).toBe('idle')
    expect(clearBody.tunnel.url).toBeNull()
    expect(clearBody.settings.publicBaseUrl).toBe('https://chat.example.com/app')
  })

  test('PUT stores the tunnel token without returning it in settings', async () => {
    const response = await api('PUT', '/api/h5-access', {
      body: { tunnelToken: 'cf-secret-token', tunnelMode: 'named' },
    })
    expect(response.status).toBe(200)
    const raw = await response.text()
    expect(raw).not.toContain('cf-secret-token')
  })
})
