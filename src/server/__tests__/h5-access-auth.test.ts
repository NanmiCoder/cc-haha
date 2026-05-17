import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { startServer } from '../index.js'
import { H5AccessService } from '../services/h5AccessService.js'
import { ProviderService } from '../services/providerService.js'

let server: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ''
let wsBaseUrl = ''
let lanBaseUrl = ''
let lanWsBaseUrl = ''
let tmpDir = ''
let originalConfigDir: string | undefined
let originalAnthropicApiKey: string | undefined
let originalH5DistDir: string | undefined
let originalClaudeAppRoot: string | undefined
let originalServerAuthRequired: string | undefined
let originalServerPort = 3456
const PHONE_ORIGIN = 'https://phone.example'

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {}

    await Bun.sleep(50)
  }

  throw new Error(`Timed out waiting for server at ${url}`)
}

function randomPort(): number {
  return 18000 + Math.floor(Math.random() * 10000)
}

function resolvePrivateLanBaseUrl(port: number): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue
      }

      if (
        entry.address.startsWith('10.') ||
        entry.address.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(entry.address)
      ) {
        return `http://${entry.address}:${port}`
      }
    }
  }

  return null
}

async function startRemoteServer(options: { authRequired?: boolean } = {}): Promise<void> {
  if (options.authRequired) {
    process.env.SERVER_AUTH_REQUIRED = '1'
  } else {
    delete process.env.SERVER_AUTH_REQUIRED
  }

  const port = randomPort()
  server = startServer(port, '0.0.0.0')
  baseUrl = `http://127.0.0.1:${port}`
  wsBaseUrl = `ws://127.0.0.1:${port}`
  lanBaseUrl = resolvePrivateLanBaseUrl(port) ?? ''
  lanWsBaseUrl = lanBaseUrl.replace(/^http/, 'ws')
  await waitForServer(`${baseUrl}/health`)
}

async function restartRemoteServer(options: { authRequired?: boolean } = {}): Promise<void> {
  server?.stop(true)
  server = undefined
  await startRemoteServer(options)
}

function makeUpgradeHeaders(origin?: string): HeadersInit {
  return {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    ...(origin ? { Origin: origin } : {}),
  }
}

function spoofedLoopbackHeaders(port: string): Record<string, string> {
  return {
    Host: `127.0.0.1:${port}`,
    Origin: 'http://127.0.0.1:5179',
  }
}

async function enableH5Access(options: {
  allowedOrigins?: string[]
  publicBaseUrl?: string | null
} = {}): Promise<string> {
  const service = new H5AccessService()
  if (options.allowedOrigins || options.publicBaseUrl !== undefined) {
    await service.updateSettings({
      allowedOrigins: options.allowedOrigins,
      publicBaseUrl: options.publicBaseUrl,
    })
  }
  const { token } = await service.enable()
  if (options.allowedOrigins || options.publicBaseUrl !== undefined) {
    await service.updateSettings({
      allowedOrigins: options.allowedOrigins,
      publicBaseUrl: options.publicBaseUrl,
    })
  }
  return token
}

function expectWebSocketOpen(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out opening websocket: ${url}`))
    }, 5000)

    ws.addEventListener('open', () => {
      clearTimeout(timeout)
      ws.close()
      resolve()
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error(`WebSocket failed to open: ${url}`))
    })
  })
}

function expectWebSocketUpgradeThenClose(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let opened = false
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out waiting for websocket close: ${url}`))
    }, 5000)

    ws.addEventListener('open', () => {
      opened = true
    })

    ws.addEventListener('close', () => {
      clearTimeout(timeout)
      if (opened) {
        resolve()
      } else {
        reject(new Error(`WebSocket closed before upgrade completed: ${url}`))
      }
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error(`WebSocket failed before upgrade completed: ${url}`))
    })
  })
}

const settingsSurfaceEndpoints = [
  { path: '/api/mcp', expected: { servers: [] } },
  { path: '/api/plugins', expected: { plugins: [] } },
  { path: '/api/agents', expectedKey: 'activeAgents' },
] as const

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'h5-access-auth-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  originalH5DistDir = process.env.CLAUDE_H5_DIST_DIR
  originalClaudeAppRoot = process.env.CLAUDE_APP_ROOT
  originalServerAuthRequired = process.env.SERVER_AUTH_REQUIRED
  originalServerPort = ProviderService.getServerPort()
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  const h5DistDir = path.join(tmpDir, 'dist')
  process.env.CLAUDE_H5_DIST_DIR = h5DistDir
  delete process.env.ANTHROPIC_API_KEY
  await fs.mkdir(path.join(h5DistDir, 'assets'), { recursive: true })
  await fs.writeFile(
    path.join(h5DistDir, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body>H5 Shell</body></html>',
    'utf-8',
  )
  await fs.writeFile(path.join(h5DistDir, 'assets/app.js'), 'window.__h5 = true', 'utf-8')
  await startRemoteServer()
})

afterEach(async () => {
  server?.stop(true)
  server = undefined
  ProviderService.setServerPort(originalServerPort)

  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir

  if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  if (originalH5DistDir === undefined) delete process.env.CLAUDE_H5_DIST_DIR
  else process.env.CLAUDE_H5_DIST_DIR = originalH5DistDir
  if (originalClaudeAppRoot === undefined) delete process.env.CLAUDE_APP_ROOT
  else process.env.CLAUDE_APP_ROOT = originalClaudeAppRoot
  if (originalServerAuthRequired === undefined) delete process.env.SERVER_AUTH_REQUIRED
  else process.env.SERVER_AUTH_REQUIRED = originalServerAuthRequired

  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('remote H5 auth and CORS integration', () => {
  test('serves the packaged H5 shell and static assets from the remote server', async () => {
    const shellResponse = await fetch(`${baseUrl}/`)
    expect(shellResponse.status).toBe(200)
    expect(shellResponse.headers.get('Content-Type')).toContain('text/html')
    await expect(shellResponse.text()).resolves.toContain('H5 Shell')

    const assetResponse = await fetch(`${baseUrl}/assets/app.js`)
    expect(assetResponse.status).toBe(200)
    expect(assetResponse.headers.get('Cache-Control')).toContain('immutable')
    await expect(assetResponse.text()).resolves.toContain('window.__h5')
  })

  test('finds Tauri packaged H5 resources under Resources/_up_/dist', async () => {
    const appRoot = path.join(tmpDir, 'Fake.app', 'Contents', 'MacOS')
    const mappedDistDir = path.join(tmpDir, 'Fake.app', 'Contents', 'Resources', '_up_', 'dist')
    delete process.env.CLAUDE_H5_DIST_DIR
    process.env.CLAUDE_APP_ROOT = appRoot

    await fs.mkdir(mappedDistDir, { recursive: true })
    await fs.writeFile(path.join(mappedDistDir, 'index.html'), 'Mapped H5 Shell', 'utf-8')

    const response = await fetch(`${baseUrl}/`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Mapped H5 Shell')
  })

  test('allows /api/status by default without H5 token or Anthropic key', async () => {
    const response = await fetch(`${baseUrl}/api/status`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('allows localhost WebUI origin without H5 token for browser development', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: 'http://127.0.0.1:5179',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5179')
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('allows the Tauri desktop WebView origin to control the local sidecar without H5 token', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: 'http://tauri.localhost',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost')
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('blocks remote browser capability requests while H5 access is disabled', async () => {
    const apiResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: PHONE_ORIGIN,
      },
    })
    expect(apiResponse.status).toBe(403)
    await expect(apiResponse.json()).resolves.toMatchObject({
      error: 'Forbidden',
    })

    const proxyResponse = await fetch(`${baseUrl}/proxy/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Origin: PHONE_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'test', messages: [] }),
    })
    expect(proxyResponse.status).toBe(403)

    const wsResponse = await fetch(`${baseUrl}/ws/h5-auth-test`, {
      headers: makeUpgradeHeaders(PHONE_ORIGIN),
    })
    expect(wsResponse.status).toBe(403)
  })

  test('blocks remote browser SDK requests while H5 access is disabled', async () => {
    const response = await fetch(`${baseUrl}/sdk/h5-auth-test`, {
      headers: makeUpgradeHeaders(PHONE_ORIGIN),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Forbidden',
    })
  })

  test('blocks remote preflight requests to capability routes while H5 access is disabled', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: PHONE_ORIGIN,
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('blocks same-origin LAN capability requests while H5 access is disabled when a LAN interface is available', async () => {
    if (!lanBaseUrl) {
      return
    }

    const apiResponse = await fetch(`${lanBaseUrl}/api/status`)

    expect(apiResponse.status).toBe(403)
    await expect(apiResponse.json()).resolves.toMatchObject({
      error: 'Forbidden',
      message: 'H5 access is disabled. Enable H5 access from the local desktop app first.',
    })

    const proxyResponse = await fetch(`${lanBaseUrl}/proxy/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'test', messages: [] }),
    })
    expect(proxyResponse.status).toBe(403)
    await expect(proxyResponse.json()).resolves.toMatchObject({
      error: 'Forbidden',
      message: 'H5 access is disabled. Enable H5 access from the local desktop app first.',
    })

    const wsResponse = await fetch(`${lanBaseUrl}/ws/h5-auth-test`, {
      headers: makeUpgradeHeaders(),
    })
    expect(wsResponse.status).toBe(403)
    await expect(wsResponse.json()).resolves.toMatchObject({
      error: 'Forbidden',
      message: 'H5 access is disabled. Enable H5 access from the local desktop app first.',
    })
  })

  test('does not trust spoofed localhost Host and Origin headers from LAN clients while H5 access is disabled', async () => {
    if (!lanBaseUrl) {
      return
    }

    const spoofedHeaders = spoofedLoopbackHeaders(new URL(lanBaseUrl).port)

    const apiResponse = await fetch(`${lanBaseUrl}/api/status`, {
      headers: spoofedHeaders,
    })
    if (apiResponse.status === 200) {
      // Some local stacks route a request to the machine's own LAN IP as a
      // loopback peer. In that case this test cannot simulate a distinct LAN
      // client; the policy-level spoof regression still covers that boundary.
      return
    }
    expect(apiResponse.status).toBe(403)

    const proxyResponse = await fetch(`${lanBaseUrl}/proxy/v1/messages`, {
      method: 'POST',
      headers: {
        ...spoofedHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'test', messages: [] }),
    })
    expect(proxyResponse.status).toBe(403)

    const wsResponse = await fetch(`${lanBaseUrl}/ws/h5-auth-test`, {
      headers: {
        ...makeUpgradeHeaders(spoofedHeaders.Origin),
        Host: spoofedHeaders.Host,
      },
    })
    expect(wsResponse.status).toBe(403)

    const controlResponse = await fetch(`${lanBaseUrl}/api/h5-access/enable`, {
      method: 'POST',
      headers: spoofedHeaders,
    })
    expect(controlResponse.status).toBe(403)
  })

  test('keeps local loopback SDK requests tokenless while H5 access is disabled', async () => {
    await expectWebSocketUpgradeThenClose(`${wsBaseUrl}/sdk/h5-auth-test`)
  })

  test('keeps local loopback adapter requests tokenless while H5 access is disabled', async () => {
    const response = await fetch(`${baseUrl}/api/adapters`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({})
  })

  test('keeps local loopback settings surface requests tokenless while H5 access is disabled', async () => {
    for (const endpoint of settingsSurfaceEndpoints) {
      const response = await fetch(`${baseUrl}${endpoint.path}`)

      expect(response.status).toBe(200)
    }
  })

  test('lets explicitly authenticated deployments use remote capability routes while H5 access is disabled', async () => {
    await restartRemoteServer({ authRequired: true })
    process.env.ANTHROPIC_API_KEY = 'test-server-key'

    const missingResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: PHONE_ORIGIN,
      },
    })
    expect(missingResponse.status).toBe(401)

    const validResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: PHONE_ORIGIN,
        Authorization: 'Bearer test-server-key',
      },
    })
    expect(validResponse.status).toBe(200)
  })

  test('keeps /api/status open by default even when a stale bearer token is sent', async () => {
    await enableH5Access()

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: 'Bearer wrong-token',
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('allows /api/status with a bearer token while default auth is open', async () => {
    const token = await enableH5Access()

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('rejects arbitrary CORS origins when H5 access is enabled', async () => {
    await enableH5Access({
      allowedOrigins: ['https://allowed.example.com'],
    })

    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        ...makeUpgradeHeaders('https://blocked.example.com'),
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(response.status).toBe(403)
  })

  test('blocks remote browsers from enabling H5 access before the local desktop opts in', async () => {
    const response = await fetch(`${baseUrl}/api/h5-access/enable`, {
      method: 'POST',
      headers: {
        Origin: PHONE_ORIGIN,
      },
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Forbidden',
    })
  })

  test('blocks remote preflight requests to the local H5 access control plane', async () => {
    const response = await fetch(`${baseUrl}/api/h5-access/enable`, {
      method: 'OPTIONS',
      headers: {
        Origin: PHONE_ORIGIN,
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('blocks authenticated remote browsers from changing H5 access settings under explicit server auth', async () => {
    await restartRemoteServer({ authRequired: true })
    process.env.ANTHROPIC_API_KEY = 'test-server-key'

    const response = await fetch(`${baseUrl}/api/h5-access/enable`, {
      method: 'POST',
      headers: {
        Origin: PHONE_ORIGIN,
        Authorization: 'Bearer test-server-key',
      },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('allows local desktop H5 access settings under explicit server auth with a valid bearer', async () => {
    await restartRemoteServer({ authRequired: true })
    process.env.ANTHROPIC_API_KEY = 'test-server-key'

    const response = await fetch(`${baseUrl}/api/h5-access/enable`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-server-key',
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toHaveProperty('token')
  })

  test('allows H5 browser requests from the configured public base URL origin', async () => {
    const token = await enableH5Access({
      publicBaseUrl: `${PHONE_ORIGIN}/h5`,
    })

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: PHONE_ORIGIN,
        Authorization: `Bearer ${token}`,
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PHONE_ORIGIN)
  })

  test('allows configured CORS origins and includes Vary: Origin', async () => {
    const token = await enableH5Access({
      allowedOrigins: ['https://allowed.example.com'],
    })

    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example.com',
        Authorization: `Bearer ${token}`,
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://allowed.example.com',
    )
    expect(response.headers.get('Vary')).toBe('Origin')
  })

  test('opens websocket upgrades without H5 token by default', async () => {
    await expectWebSocketOpen(`${wsBaseUrl}/ws/h5-auth-test`)
  })

  test('requires H5 token for remote browser REST requests when H5 access is enabled', async () => {
    const token = await enableH5Access({
      allowedOrigins: [PHONE_ORIGIN],
    })

    const missingTokenResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: PHONE_ORIGIN,
      },
    })
    expect(missingTokenResponse.status).toBe(401)

    const validTokenResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: PHONE_ORIGIN,
        Authorization: `Bearer ${token}`,
      },
    })
    expect(validTokenResponse.status).toBe(200)
  })

  test('requires H5 token for remote browser settings surface requests when H5 access is enabled', async () => {
    const token = await enableH5Access({
      allowedOrigins: [PHONE_ORIGIN],
    })

    for (const endpoint of settingsSurfaceEndpoints) {
      const missingTokenResponse = await fetch(`${baseUrl}${endpoint.path}`, {
        headers: {
          Origin: PHONE_ORIGIN,
        },
      })
      expect(missingTokenResponse.status).toBe(401)

      const wrongTokenResponse = await fetch(`${baseUrl}${endpoint.path}`, {
        headers: {
          Origin: PHONE_ORIGIN,
          Authorization: 'Bearer wrong-token',
        },
      })
      expect(wrongTokenResponse.status).toBe(401)

      const validTokenResponse = await fetch(`${baseUrl}${endpoint.path}`, {
        headers: {
          Origin: PHONE_ORIGIN,
          Authorization: `Bearer ${token}`,
        },
      })
      expect(validTokenResponse.status).toBe(200)
      expect(validTokenResponse.headers.get('Access-Control-Allow-Origin')).toBe(PHONE_ORIGIN)
      const body = await validTokenResponse.json()
      if ('expected' in endpoint) {
        expect(body).toMatchObject(endpoint.expected)
      } else {
        expect(body).toHaveProperty(endpoint.expectedKey)
      }
    }
  })

  test('does not allow the server API key to replace the H5 token for remote browser requests', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-server-key'
    await enableH5Access({
      allowedOrigins: [PHONE_ORIGIN],
    })

    const apiResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: PHONE_ORIGIN,
        Authorization: 'Bearer test-server-key',
      },
    })
    expect(apiResponse.status).toBe(401)
    await expect(apiResponse.json()).resolves.toMatchObject({
      message: 'Invalid H5 access token',
    })

    const proxyResponse = await fetch(`${baseUrl}/proxy/v1/messages`, {
      method: 'POST',
      headers: {
        Origin: PHONE_ORIGIN,
        Authorization: 'Bearer test-server-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'test', messages: [] }),
    })
    expect(proxyResponse.status).toBe(401)

    const wsResponse = await fetch(`${baseUrl}/ws/h5-auth-test`, {
      headers: {
        ...makeUpgradeHeaders(PHONE_ORIGIN),
        Authorization: 'Bearer test-server-key',
      },
    })
    expect(wsResponse.status).toBe(401)
  })

  test('requires H5 token for remote browser proxy requests when H5 access is enabled', async () => {
    const token = await enableH5Access({
      allowedOrigins: [PHONE_ORIGIN],
    })

    const missingTokenResponse = await fetch(`${baseUrl}/proxy/v1/messages`, {
      method: 'POST',
      headers: {
        Origin: PHONE_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'test', messages: [] }),
    })
    expect(missingTokenResponse.status).toBe(401)

    const validTokenResponse = await fetch(`${baseUrl}/proxy/v1/messages`, {
      method: 'POST',
      headers: {
        Origin: PHONE_ORIGIN,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'test', messages: [] }),
    })
    expect(validTokenResponse.status).toBe(400)
    expect(validTokenResponse.headers.get('Access-Control-Allow-Origin')).toBe(PHONE_ORIGIN)
    await expect(validTokenResponse.json()).resolves.toMatchObject({
      error: {
        type: 'invalid_request_error',
      },
    })
  })

  test('keeps Tauri loopback REST requests tokenless when H5 access is enabled', async () => {
    await enableH5Access()

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: 'http://tauri.localhost',
      },
    })

    expect(response.status).toBe(200)
  })

  test('keeps local loopback websocket and SDK requests tokenless when H5 access is enabled', async () => {
    await enableH5Access()

    await expectWebSocketOpen(`${wsBaseUrl}/ws/h5-auth-test`)
    await expectWebSocketUpgradeThenClose(`${wsBaseUrl}/sdk/h5-auth-test`)
  })

  test('keeps local loopback adapter requests tokenless when H5 access is enabled', async () => {
    await enableH5Access()

    const response = await fetch(`${baseUrl}/api/adapters`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({})
  })

  test('keeps local loopback settings surface requests tokenless when H5 access is enabled', async () => {
    await enableH5Access()

    for (const endpoint of settingsSurfaceEndpoints) {
      const response = await fetch(`${baseUrl}${endpoint.path}`)

      expect(response.status).toBe(200)
    }
  })

  test('blocks adapter requests from non-local browser origins when H5 access is enabled', async () => {
    await enableH5Access()

    const response = await fetch(`${baseUrl}/api/adapters`, {
      headers: {
        Origin: PHONE_ORIGIN,
      },
    })

    expect(response.status).toBe(403)
  })

  test('blocks settings surface requests from untrusted browser origins when H5 access is enabled', async () => {
    await enableH5Access()

    for (const endpoint of settingsSurfaceEndpoints) {
      const response = await fetch(`${baseUrl}${endpoint.path}`, {
        headers: {
          Origin: PHONE_ORIGIN,
        },
      })

      expect(response.status).toBe(403)
    }
  })

  test('requires H5 token for remote browser websocket requests when H5 access is enabled', async () => {
    const token = await enableH5Access({
      allowedOrigins: [PHONE_ORIGIN],
    })

    const missingTokenResponse = await fetch(`${baseUrl}/ws/h5-auth-test`, {
      headers: makeUpgradeHeaders(PHONE_ORIGIN),
    })
    expect(missingTokenResponse.status).toBe(401)

    const validTokenResponse = await fetch(`${baseUrl}/ws/h5-auth-test?token=${token}`, {
      headers: makeUpgradeHeaders(PHONE_ORIGIN),
    })
    expect(validTokenResponse.status).toBe(400)
    await expect(validTokenResponse.text()).resolves.toBe('WebSocket upgrade failed')
  })

  test('requires H5 token for remote browser SDK requests when H5 access is enabled', async () => {
    const token = await enableH5Access({
      allowedOrigins: [PHONE_ORIGIN],
    })

    const missingTokenResponse = await fetch(`${baseUrl}/sdk/h5-auth-test`, {
      headers: makeUpgradeHeaders(PHONE_ORIGIN),
    })
    expect(missingTokenResponse.status).toBe(403)

    const validTokenResponse = await fetch(`${baseUrl}/sdk/h5-auth-test?token=${token}`, {
      headers: makeUpgradeHeaders(PHONE_ORIGIN),
    })
    expect(validTokenResponse.status).toBe(403)
  })

  test('blocks remote browser SDK requests even under explicit server auth', async () => {
    await restartRemoteServer({ authRequired: true })
    process.env.ANTHROPIC_API_KEY = 'test-server-key'

    const response = await fetch(`${baseUrl}/sdk/h5-auth-test`, {
      headers: {
        ...makeUpgradeHeaders(PHONE_ORIGIN),
        Authorization: 'Bearer test-server-key',
      },
    })

    expect(response.status).toBe(403)
  })

  test('honors explicit auth opt-in for REST and websocket requests', async () => {
    await restartRemoteServer({ authRequired: true })
    const token = await enableH5Access()

    const missingStatusResponse = await fetch(`${baseUrl}/api/status`)
    expect(missingStatusResponse.status).toBe(401)

    const wrongStatusResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: 'Bearer wrong-token',
      },
    })
    expect(wrongStatusResponse.status).toBe(401)

    const validStatusResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(validStatusResponse.status).toBe(200)

    const missingTokenResponse = await fetch(`${baseUrl}/ws/h5-auth-test`, {
      headers: makeUpgradeHeaders(),
    })
    expect(missingTokenResponse.status).toBe(401)

    const wrongTokenResponse = await fetch(`${baseUrl}/ws/h5-auth-test?token=wrong-token`, {
      headers: makeUpgradeHeaders(),
    })
    expect(wrongTokenResponse.status).toBe(401)

    await expectWebSocketOpen(`${wsBaseUrl}/ws/h5-auth-test?token=${token}`)
  })
})
