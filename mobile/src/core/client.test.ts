import { describe, expect, test } from 'bun:test'
import { ApiClient, bytesToBase64, type FetchAdapter, type FetchResponse } from './client'
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
    // 服务端把机器码放在 error 里；没有 code 字段时也要保留，调用方才能识别。
    const rewritten = new ApiClient(lan, 'fake', {
      fetch: async () =>
        response(
          { error: 'HISTORY_CHANGED', message: 'Session history changed' },
          409
        ),
    })
    await expect(rewritten.history('session', 'opaque')).rejects.toMatchObject({
      status: 409,
      code: 'HISTORY_CHANGED',
      message: 'Session history changed',
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
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
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
        calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined })
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
      `${lan.url}/api/sessions/session-id/messages?media=ref&cursor=opaque%2F%2B%3D%3D`
    )
  })

  test('raw binary uploads preserve only the selected bytes and retain host-scoped transport controls', async () => {
    const calls: { url: string; init: Parameters<FetchAdapter>[1] }[] = []
    const client = new ApiClient(remote, 'voice-fixture-token', {
      fetch: async (url, init) => {
        calls.push({ url, init })
        return response({ text: 'hello' })
      },
    })
    const backing = new Uint8Array([99, 82, 73, 70, 70, 88])
    await client.request('/api/voice/transcribe', {
      method: 'POST', rawBody: backing.subarray(1, 5), contentType: 'audio/wav',
    })
    backing.fill(0)
    expect(calls[0].init.body).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(calls[0].init.body as ArrayBuffer))).toEqual([82, 73, 70, 70])
    expect(calls[0]).toMatchObject({
      url: `${remote.url}/api/voice/transcribe`,
      init: {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'audio/wav', Authorization: 'Bearer voice-fixture-token', Origin: remote.url },
      },
    })
    await client.post('/api/sessions', { workDir: '/fixture' })
    expect(calls[1].init.body).toBe('{"workDir":"/fixture"}')
    expect(calls[1].init.headers['Content-Type']).toBe('application/json')
  })

  test('does not accept an ambiguous JSON and raw body or an unsafe path for binary uploads', async () => {
    let calls = 0
    const client = new ApiClient(lan, 'fixture', {
      fetch: async () => {
        calls++
        return response({})
      },
    })
    await expect(client.request('/api/voice/transcribe', {
      method: 'POST', body: {}, rawBody: new Uint8Array([1]), contentType: 'audio/wav',
    })).rejects.toMatchObject({ code: 'INVALID_BODY' })
    await expect(client.request('//other.invalid/upload', {
      method: 'POST', rawBody: new Uint8Array([1]), contentType: 'audio/wav',
    })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(calls).toBe(0)
  })

  test('binary uploads refuse redirected response bodies and forward active cancellation', async () => {
    let bodyRead = false
    const redirected = new ApiClient(remote, 'fixture', {
      fetch: async () => response({}, 200, {
        redirected: true,
        text: async () => {
          bodyRead = true
          return '{}'
        },
      }),
    })
    await expect(redirected.request('/api/voice/transcribe', {
      method: 'POST', rawBody: new Uint8Array([1]), contentType: 'audio/wav',
    })).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' })
    expect(bodyRead).toBe(false)
    const controller = new AbortController()
    let transportSignal: AbortSignal | undefined
    const waiting = new ApiClient(lan, 'fixture', {
      fetch: async (_url, init) => {
        transportSignal = init.signal
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true }))
      },
    })
    const request = waiting.request('/api/voice/transcribe', {
      method: 'POST', rawBody: new Uint8Array([1]), contentType: 'audio/wav', signal: controller.signal,
    })
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'ABORTED' })
    expect(transportSignal?.aborted).toBe(true)
  })
})

describe('slow links and tool images', () => {
  const slowBody = (delayMs: number, body = '{"ok":true}'): FetchAdapter => async (_url, init) =>
    response({}, 200, {
      text: () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(body), delayMs)
        init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
      }),
    })

  test('a body that keeps arriving after the computer answered is not reported as an offline computer', async () => {
    const client = new ApiClient(lan, 'fake', { fetch: slowBody(40), timeoutMs: 10, bodyTimeoutMs: 200 })
    await expect(client.get('/api/sessions')).resolves.toEqual({ ok: true })
  })

  test('headers and body time out separately with distinct messages', async () => {
    const silent: FetchAdapter = async (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    await expect(new ApiClient(lan, 'fake', { fetch: silent, timeoutMs: 10, bodyTimeoutMs: 200 }).get('/api/sessions'))
      .rejects.toMatchObject({ code: 'TIMEOUT', message: '连接超时，请检查电脑是否在线' })
    await expect(new ApiClient(lan, 'fake', { fetch: slowBody(500), timeoutMs: 10, bodyTimeoutMs: 30 }).get('/api/sessions'))
      .rejects.toMatchObject({ code: 'TIMEOUT', message: '网络太慢，内容没能及时传完，请稍后重试' })
  })

  test('history always asks for tool images by reference', async () => {
    const urls: string[] = []
    const client = new ApiClient(remote, 'fake', { fetch: async (url) => { urls.push(url); return response({ messages: [] }) } })
    await client.history('session-id')
    expect(urls).toEqual([`${remote.url}/api/sessions/session-id/messages?media=ref`])
  })

  test('downloads a referenced image as a data URI with the served type', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250, 251])
    const calls: { url: string; init: Parameters<FetchAdapter>[1] }[] = []
    const client = new ApiClient(remote, 'fake-token', {
      fetch: async (url, init) => {
        calls.push({ url, init })
        return response({}, 200, {
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/webp' : null },
          arrayBuffer: async () => bytes.buffer,
        })
      },
    })
    const uri = await client.image('/api/sessions/s-1/tool-images/toolu_1/0', 'thumb')
    expect(uri).toBe(`data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`)
    expect(calls[0].url).toBe(`${remote.url}/api/sessions/s-1/tool-images/toolu_1/0?variant=thumb`)
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer fake-token', Origin: remote.url, Accept: 'image/*' })
  })

  test('refuses non-image paths, active image types and error bodies', async () => {
    const client = (contentType: string, status = 200) => new ApiClient(lan, 'fake', {
      fetch: async () => response({ error: 'Tool image not found' }, status, {
        headers: { get: () => contentType },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      }),
    })
    await expect(client('image/png').image('/api/sessions/s/messages', 'full')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(client('image/png').image('/api/sessions/s/tool-images/t/0?variant=x', 'full')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(client('image/svg+xml').image('/api/sessions/s/tool-images/t/0', 'full')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client('text/html').image('/api/sessions/s/tool-images/t/0', 'full')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client('application/json', 404).image('/api/sessions/s/tool-images/t/0', 'full')).rejects.toMatchObject({ status: 404, message: 'Tool image not found' })
  })

  test('base64 encoding matches the platform encoder at every padding length', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 3 * 4096 - 1, 3 * 4096, 3 * 4096 + 1, 50_000]) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) bytes[i] = (i * 131 + 7) & 255
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    }
  })
})
