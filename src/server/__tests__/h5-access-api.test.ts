import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'

let tmpDir: string
let originalConfigDir: string | undefined

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
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('/api/h5-access', () => {
  test('GET returns sanitized disabled status by default', async () => {
    const response = await api('GET', '/api/h5-access')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      settings: {
        enabled: false,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: null,
      },
    })
  })

  test('enable returns raw token once and status stays sanitized', async () => {
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

    const statusResponse = await api('GET', '/api/h5-access')
    expect(statusResponse.status).toBe(200)
    const statusPayload = await statusResponse.json() as {
      settings: {
        enabled: boolean
        tokenPreview: string | null
      }
      token?: string
    }

    expect(statusPayload.settings.enabled).toBe(true)
    expect(statusPayload.settings.tokenPreview).toBe(enablePayload.settings.tokenPreview)
    expect(statusPayload.token).toBeUndefined()
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

  test('disable clears access and causes the old token to fail verification', async () => {
    const enableResponse = await api('POST', '/api/h5-access/enable')
    const enablePayload = await enableResponse.json() as { token: string }

    const disableResponse = await api('POST', '/api/h5-access/disable')
    expect(disableResponse.status).toBe(200)
    await expect(disableResponse.json()).resolves.toEqual({
      settings: {
        enabled: false,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: null,
      },
    })

    expect(
      await api('POST', '/api/h5-access/verify', { bearerToken: enablePayload.token }),
    ).toMatchObject({ status: 401 })
  })

  test('PUT updates sanitized settings', async () => {
    const response = await api('PUT', '/api/h5-access', {
      body: {
        allowedOrigins: ['https://example.com/path'],
        publicBaseUrl: 'https://public.example.com/app/',
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      settings: {
        enabled: false,
        tokenPreview: null,
        allowedOrigins: ['https://example.com'],
        publicBaseUrl: 'https://public.example.com/app',
      },
    })
  })
})
