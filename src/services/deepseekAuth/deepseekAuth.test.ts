import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DEEPSEEK_INFERENCE_ORIGIN,
  DEEPSEEK_PLATFORM_ORIGIN,
  DeepSeekAuthError,
  buildDeepSeekClientHeaders,
  fetchDeepSeekProfile,
  getDeepSeekPlatformOrigin,
  initDeepSeekAuth,
  normalizeDeepSeekLocale,
} from './client.js'
import { buildDeepSeekFetch } from './fetch.js'
import {
  DEEPSEEK_OAUTH_FILE_ENV_KEY,
  getDeepSeekOAuthTokens,
  writeDeepSeekOAuthTokenFile,
} from './storage.js'

const identity = { version: '1.2.3', locale: 'en-US', timezoneOffsetSeconds: 28_800 }

let tempDir: string
let tokenFile: string
let previousFile: string | undefined
let previousOrigin: string | undefined

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-auth-'))
  tokenFile = path.join(tempDir, 'deepseek-oauth.json')
  previousFile = process.env[DEEPSEEK_OAUTH_FILE_ENV_KEY]
  previousOrigin = process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN
  process.env[DEEPSEEK_OAUTH_FILE_ENV_KEY] = tokenFile
  delete process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN
})

afterEach(() => {
  if (previousFile === undefined) delete process.env[DEEPSEEK_OAUTH_FILE_ENV_KEY]
  else process.env[DEEPSEEK_OAUTH_FILE_ENV_KEY] = previousFile
  if (previousOrigin === undefined) delete process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN
  else process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN = previousOrigin
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function storeGrant(token = 'dsh_live_token', issuer = DEEPSEEK_PLATFORM_ORIGIN) {
  writeDeepSeekOAuthTokenFile(tokenFile, { token, issuer, deviceId: 'device-1' })
}

function recordingFetch(respond: () => Response) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return respond()
  }) as typeof fetch
  return { calls, impl }
}

describe('buildDeepSeekFetch', () => {
  test('replaces the Anthropic key headers with the account token for the inference origin', async () => {
    storeGrant()
    const upstream = recordingFetch(() => new Response('{}'))
    const wrapped = buildDeepSeekFetch(upstream.impl)

    await wrapped(`${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': 'deepseek-oauth-dummy-key',
        authorization: 'Bearer dummy',
        'anthropic-version': '2023-06-01',
      },
      body: '{}',
    })

    const [call] = upstream.calls
    expect(call!.headers.get('x-dsh-auth-token')).toBe('dsh_live_token')
    expect(call!.headers.get('x-api-key')).toBeNull()
    expect(call!.headers.get('authorization')).toBeNull()
    expect(call!.headers.get('anthropic-version')).toBe('2023-06-01')
  })

  test('never attaches the grant to another origin', async () => {
    storeGrant()
    const upstream = recordingFetch(() => new Response('{}'))
    const wrapped = buildDeepSeekFetch(upstream.impl)

    await wrapped('https://example.com/v1/messages', {
      headers: { 'x-api-key': 'keep-me' },
    })

    const [call] = upstream.calls
    expect(call!.headers.get('x-dsh-auth-token')).toBeNull()
    expect(call!.headers.get('x-api-key')).toBe('keep-me')
  })

  test('answers signed-out requests locally without contacting DeepSeek', async () => {
    const upstream = recordingFetch(() => new Response('{}'))
    const wrapped = buildDeepSeekFetch(upstream.impl)

    const response = await wrapped(`${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('authentication_error')
    expect(body.error.message).toContain('not signed in')
    expect(upstream.calls).toHaveLength(0)
  })

  test('forgets a rejected grant but keeps a newer login', async () => {
    storeGrant('dsh_old_token')
    const rejected = buildDeepSeekFetch(
      (async () => {
        // A login completes while the request is in flight.
        storeGrant('dsh_new_token')
        return new Response('{}', { status: 401 })
      }) as unknown as typeof fetch,
    )
    await rejected(`${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(getDeepSeekOAuthTokens()?.token).toBe('dsh_new_token')

    const rejectedAgain = buildDeepSeekFetch(
      (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    )
    await rejectedAgain(`${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(getDeepSeekOAuthTokens()).toBeNull()
  })

  test('refuses redirects so the token cannot follow one to another origin', async () => {
    storeGrant()
    let redirect: RequestRedirect | undefined
    const wrapped = buildDeepSeekFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect
      return new Response('{}')
    }) as unknown as typeof fetch)

    await wrapped(`${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`, {
      method: 'POST',
      body: '{}',
      redirect: 'follow',
    })

    expect(redirect).toBe('error')
  })

  test('marks the local sign-in-required answer as not retryable', async () => {
    const wrapped = buildDeepSeekFetch((async () => new Response('{}')) as unknown as typeof fetch)
    const response = await wrapped(`${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`, {
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('x-should-retry')).toBe('false')
  })

  test('never sends a grant from an overridden platform origin to the production API', async () => {
    process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN = 'http://127.0.0.1:4000'
    storeGrant('dsh_staging_token', 'http://127.0.0.1:4000')
    // It is a valid sign-in for the overridden platform...
    expect(getDeepSeekOAuthTokens()?.token).toBe('dsh_staging_token')
    const upstream = recordingFetch(() => new Response('{}'))
    const response = await buildDeepSeekFetch(upstream.impl)(
      `${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`,
      { method: 'POST', body: '{}' },
    )
    // ...but it must not authenticate production model requests.
    expect(response.status).toBe(401)
    expect(upstream.calls).toHaveLength(0)

    delete process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN
    storeGrant('dsh_mock_development_token')
    const mock = await buildDeepSeekFetch(upstream.impl)(
      `${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`,
      { method: 'POST', body: '{}' },
    )
    expect(mock.status).toBe(401)
    expect(upstream.calls).toHaveLength(0)
  })

  test('ignores a grant issued by a different platform origin', async () => {
    storeGrant('dsh_mock_token', 'http://127.0.0.1:4000')
    expect(getDeepSeekOAuthTokens()).toBeNull()
    const upstream = recordingFetch(() => new Response('{}'))
    const response = await buildDeepSeekFetch(upstream.impl)(
      `${DEEPSEEK_INFERENCE_ORIGIN}/anthropic/v1/messages`,
      { method: 'POST', body: '{}' },
    )
    expect(response.status).toBe(401)
    expect(upstream.calls).toHaveLength(0)
  })
})

describe('DeepSeek platform client', () => {
  function platformJson(data: unknown, status = 200): typeof fetch {
    return (async () => Response.json(data, { status })) as unknown as typeof fetch
  }
  const initInput = {
    codeChallenge: 'challenge',
    state: 'state',
    redirectUri: 'http://127.0.0.1:5555/oauth/callback',
    identity,
  }

  test('rejects an authorize URL outside the platform origin or path', async () => {
    for (const authorize_url of [
      'https://evil.example/dsh/authorize',
      `${DEEPSEEK_PLATFORM_ORIGIN}/somewhere/else`,
    ]) {
      await expect(
        initDeepSeekAuth({
          ...initInput,
          fetchOverride: platformJson({
            code: 0,
            data: {
              biz_code: 0,
              biz_data: { authorize_url, authorize_id: 'a', expires_in: 60 },
            },
          }),
        }),
      ).rejects.toMatchObject({ code: 'protocol' })
    }
  })

  test('maps credential rejection and business failure to stable codes', async () => {
    const profile = (fetchOverride: typeof fetch) =>
      fetchDeepSeekProfile('dsh_live_token', { identity, fetchOverride })

    await expect(profile(platformJson({}, 401))).rejects.toMatchObject({
      code: 'unauthorized',
    })
    await expect(profile(platformJson({ code: 40003 }))).rejects.toMatchObject({
      code: 'unauthorized',
    })
    await expect(
      profile(platformJson({ code: 0, data: { biz_code: 7, biz_data: null } })),
    ).rejects.toBeInstanceOf(DeepSeekAuthError)
    await expect(
      profile(
        platformJson({
          code: 0,
          data: {
            biz_code: 0,
            biz_data: { email: 'a***@example.com', id_profile: { name: 'A' } },
          },
        }),
      ),
    ).resolves.toEqual({ name: 'A', contact: 'a***@example.com' })
  })

  test('derives the five client headers from platform and locale', () => {
    expect(buildDeepSeekClientHeaders(identity, 'darwin')).toEqual({
      'x-client-bundle-id': '',
      'x-client-platform': 'desktop-mac',
      'x-client-version': '1.2.3',
      'x-client-locale': 'en_US',
      'x-client-timezone-offset': '28800',
    })
    expect(buildDeepSeekClientHeaders(identity, 'win32')['x-client-platform']).toBe('desktop-win')
    expect(buildDeepSeekClientHeaders(identity, 'linux')['x-client-platform']).toBe('web')
    expect(normalizeDeepSeekLocale('zh-TW')).toBe('zh_CN')
    expect(normalizeDeepSeekLocale('ja')).toBe('en_US')
  })

  test('only accepts HTTPS or loopback HTTP platform overrides', () => {
    for (const [value, expected] of [
      ['http://127.0.0.1:4000', 'http://127.0.0.1:4000'],
      ['https://platform.example.test', 'https://platform.example.test'],
      ['http://platform.example.test', DEEPSEEK_PLATFORM_ORIGIN],
      ['https://user:pw@platform.example.test', DEEPSEEK_PLATFORM_ORIGIN],
      ['https://platform.example.test/path', DEEPSEEK_PLATFORM_ORIGIN],
      ['not a url', DEEPSEEK_PLATFORM_ORIGIN],
    ] as const) {
      process.env.CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN = value
      expect(getDeepSeekPlatformOrigin()).toBe(expected)
    }
  })
})
