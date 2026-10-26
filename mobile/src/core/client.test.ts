import { describe, expect, test } from 'bun:test'
import { ApiClient, type FetchAdapter, type FetchResponse } from './client'
import type { Host } from './types'

const lan: Host = {
  id: 'a',
  name: 'A',
  url: 'http://192.168.1.12:3456',
  auth: 'lan',
}
const remote: Host = {
  id: 'b',
  name: 'B',
  url: 'https://fixture.invalid',
  auth: 'remote',
}
const response = (
  body: unknown,
  status = 200,
  extra: Partial<FetchResponse> = {}
): FetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  url: '',
  redirected: false,
  text: async () => JSON.stringify(body),
  ...extra,
})

describe('host-scoped API transport', () => {
  test('concurrent clients keep their own destination and credential', async () => {
    const calls: { url: string; init: Parameters<FetchAdapter>[1] }[] = []
    const fetch: FetchAdapter = async (url, init) => {
      calls.push({ url, init })
      return response({ sessions: [], total: 0 })
    }
    const mutableHost = { ...lan }
    const a = new ApiClient(mutableHost, 'a-token', { fetch })
    const b = new ApiClient(remote, 'b-token', { fetch })
    mutableHost.url = 'http://192.168.1.99:3456'
    await Promise.all([a.listSessions(), b.listSessions()])
    expect(calls.map((c) => c.url)).toEqual([
      `${lan.url}/api/sessions`,
      `${remote.url}/api/sessions`,
    ])
    expect(calls[0].init.headers.Authorization).toBe('Bearer a-token')
    expect(calls[1].init.headers).toMatchObject({
      Authorization: 'Bearer b-token',
      Origin: remote.url,
    })
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a.host)).toBe(true)
    expect(JSON.stringify(a)).not.toContain('a-token')
  })

  test('requests configure transport to block redirect before it happens', async () => {
    const fetch: FetchAdapter = async (_url, init) => {
      expect(init.redirect).toBe('error')
      expect(init.credentials).toBe('omit')
      return response({}, 302)
    }
    await expect(
      new ApiClient(lan, 'fake', { fetch }).get('/api/sessions')
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' })
  })

  test('refuses redirected responses from a broken injected adapter', async () => {
    for (const extra of [
      { redirected: true },
      { url: 'https://other.invalid/api/sessions' },
    ]) {
      let bodyRead = false
      const fetch: FetchAdapter = async () =>
        response({}, 200, {
          ...extra,
          text: async () => {
            bodyRead = true
            return '{}'
          },
        })
      await expect(
        new ApiClient(remote, 'fake', { fetch }).get('/api/sessions')
      ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' })
      expect(bodyRead).toBe(false)
    }
  })

  test('rejects cross-host paths before invoking transport', async () => {
    let calls = 0
    const client = new ApiClient(lan, 'fake', {
      fetch: async () => {
        calls++
        return response({})
      },
    })
    for (const path of [
      'https://other.invalid/api',
      '//other.invalid/api',
      '/\\other.invalid',
      '/api#fragment',
    ])
      await expect(client.get(path)).rejects.toMatchObject({
        code: 'INVALID_PATH',
      })
    expect(calls).toBe(0)
  })

  test('preserves actionable server status/code and rejects non-JSON responses', async () => {
    const stale = new ApiClient(lan, 'fake', {
      fetch: async () =>
        response(
          { message: 'history changed', code: 'HISTORY_PAGE_STALE' },
          409
        ),
    })
    await expect(stale.history('session', 'opaque')).rejects.toMatchObject({
      status: 409,
      code: 'HISTORY_PAGE_STALE',
      message: 'history changed',
    })
    const html = new ApiClient(lan, 'fake', {
      fetch: async () =>
        response({}, 200, { text: async () => '<html>proxy</html>' }),
    })
    await expect(html.listSessions()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  test('timeout aborts the actual transport and reports a safe error', async () => {
    let aborted = false
    const fetch: FetchAdapter = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('fake provider details'))
          },
          { once: true }
        )
      })
    await expect(
      new ApiClient(lan, 'fake-secret', { fetch, timeoutMs: 5 }).listSessions()
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(aborted).toBe(true)
  })

  test('caller cancellation is distinct from timeout', async () => {
    const controller = new AbortController()
    let calls = 0
    const client = new ApiClient(lan, 'fake', {
      fetch: async () => {
        calls++
        return response({})
      },
    })
    controller.abort()
    await expect(
      client.get('/api/sessions', { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(calls).toBe(0)
  })

  test('LAN verification uses POST and forwards cancellation to its transport', async () => {
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    const fetch: FetchAdapter = async (url, init) => {
      expect(url).toBe(`${lan.url}/api/h5-access/verify`)
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer fixture-token')
      expect(init.body).toBeUndefined()
      signal = init.signal
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true }
        )
      )
    }
    const verification = new ApiClient(lan, 'fixture-token', { fetch }).verify({
      signal: controller.signal,
    })
    controller.abort()
    await expect(verification).rejects.toMatchObject({ code: 'ABORTED' })
    expect(signal?.aborted).toBe(true)
  })

  test('verification honors a request-specific timeout', async () => {
    const fetch: FetchAdapter = async (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          'abort',
          () => reject(new Error('timeout')),
          { once: true }
        )
      )
    const verification = new ApiClient(lan, 'fixture-token', {
      fetch,
      timeoutMs: 5000,
    }).verify({ timeoutMs: 5 })
    await expect(verification).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  test('remote verification keeps GET and forwards an already-canceled signal', async () => {
    const methods: string[] = []
    const fetch: FetchAdapter = async (_url, init) => {
      methods.push(init.method)
      return response({ authenticated: true })
    }
    const client = new ApiClient(remote, 'fixture-token', { fetch })
    expect(await client.verify()).toEqual({ ok: true })
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.verify({ signal: controller.signal })
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(methods).toEqual(['GET'])
  })

  test('uses native pairing payload and validates remote authentication separately', async () => {
    const calls: {
      url: string
      body: unknown
      headers: Record<string, string>
    }[] = []
    const fetch: FetchAdapter = async (url, init) => {
      calls.push({
        url,
        body: init.body ? JSON.parse(init.body) : undefined,
        headers: init.headers,
      })
      if (url.endsWith('/pair'))
        return response({ id: 'pair-id', claimSecret: 'claim-secret' })
      if (url.endsWith('/claim'))
        return response({
          status: 'approved',
          token: 'native-token',
          tokenType: 'Bearer',
          deviceId: 'device',
          expiresAt: 12345,
        })
      return response({ authenticated: false })
    }
    const client = new ApiClient(remote, '', { fetch })
    expect(await client.pair('pair-secret', 'Test phone')).toEqual({
      id: 'pair-id',
      claimSecret: 'claim-secret',
    })
    expect(calls[0].body).toEqual({
      secret: 'pair-secret',
      name: 'Test phone',
      clientType: 'native',
    })
    expect(calls[0].headers.Origin).toBe(remote.url)
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(await client.claimPair('pair-id', 'claim-secret')).toMatchObject({
      status: 'approved',
      token: 'native-token',
      tokenType: 'Bearer',
    })
    expect(calls[1].body).toEqual({
      id: 'pair-id',
      claimSecret: 'claim-secret',
    })
    await expect(client.verify()).rejects.toMatchObject({
      code: 'PAIRING_REQUIRED',
    })
    expect(calls[2].url).toBe(`${remote.url}/api/public-access/session`)
  })

  test('uses the desktop create-session and cursor contracts without adding model fields', async () => {
    const calls: { url: string; body?: string }[] = []
    const client = new ApiClient(lan, 'fake', {
      fetch: async (url, init) => {
        calls.push({ url, body: init.body })
        return response({})
      },
    })
    const input = {
      workDir: '/fixture/project',
      permissionMode: 'plan' as const,
      agentProfile: 'lean' as const,
      repository: { branch: 'main', worktree: true },
    }
    await client.createSession(input)
    await client.history('session-id', 'opaque/+==')
    expect(JSON.parse(calls[0].body!)).toEqual(input)
    expect(calls[1].url).toBe(
      `${lan.url}/api/sessions/session-id/messages?cursor=opaque%2F%2B%3D%3D`
    )
  })
})
