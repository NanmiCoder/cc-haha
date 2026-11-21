import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { traceCaptureService } from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleProxyRequest } from './handler.js'
import {
  getEffectiveUpstreamSessionId,
  markUpstreamSessionSuccess,
  recordSessionLimitExceeded,
  resetSessionRotationForTests,
  templateCarriesSessionId,
} from './sessionRotation.js'

describe('upstream session-id rotation state', () => {
  beforeEach(() => resetSessionRotationForTests())
  afterEach(() => resetSessionRotationForTests())

  test('a template without the session placeholder does not opt in', () => {
    expect(templateCarriesSessionId(undefined)).toBe(false)
    expect(templateCarriesSessionId({ 'User-Agent': 'cc-haha/$VERSION' })).toBe(false)
  })

  test('a template with the session placeholder opts in', () => {
    expect(templateCarriesSessionId({ 'x-opencode-session': '$SESSION_ID' })).toBe(true)
  })

  test('returns the inbound id until a rotation is recorded', () => {
    expect(getEffectiveUpstreamSessionId('sess-a')).toBe('sess-a')
    expect(recordSessionLimitExceeded('sess-a', 'sess-a')).toBe('sess-a-r1')
    expect(getEffectiveUpstreamSessionId('sess-a')).toBe('sess-a-r1')
    // An unrelated conversation is untouched.
    expect(getEffectiveUpstreamSessionId('sess-b')).toBe('sess-b')
  })

  test('refusing a rotated id disables rotation for the conversation', () => {
    expect(recordSessionLimitExceeded('sess-a', 'sess-a')).toBe('sess-a-r1')
    // The relay refused the rotated id too: it counts on something else.
    expect(recordSessionLimitExceeded('sess-a', 'sess-a-r1')).toBeNull()
    expect(getEffectiveUpstreamSessionId('sess-a')).toBe('sess-a')
    // Disabled stays disabled, even when attempted with the original id again.
    expect(recordSessionLimitExceeded('sess-a', 'sess-a')).toBeNull()
  })

  test('rotations are bounded per conversation', () => {
    let next = recordSessionLimitExceeded('sess-a', 'sess-a')
    let count = 1
    while (next !== null) {
      // Each rotated id serves successful requests before its counter, too,
      // runs out — that is the path that keeps rotating instead of disabling.
      markUpstreamSessionSuccess('sess-a', getEffectiveUpstreamSessionId('sess-a'))
      next = recordSessionLimitExceeded('sess-a', getEffectiveUpstreamSessionId('sess-a'))
      count += 1
    }
    // 25 successful rotations (r1…r25) plus the 26th that returned null.
    expect(count).toBe(26)
    // At the cap the conversation stops rotating: the inbound id passes through.
    expect(getEffectiveUpstreamSessionId('sess-a')).toBe('sess-a')
  })

  test('a rotated id that served successfully rotates onward instead of disabling', () => {
    expect(recordSessionLimitExceeded('sess-a', 'sess-a')).toBe('sess-a-r1')
    markUpstreamSessionSuccess('sess-a', getEffectiveUpstreamSessionId('sess-a'))
    expect(recordSessionLimitExceeded('sess-a', 'sess-a-r1')).toBe('sess-a-r2')
    expect(getEffectiveUpstreamSessionId('sess-a')).toBe('sess-a-r2')
  })

  test('does not let a stale success bless a newer rotation', () => {
    recordSessionLimitExceeded('sess-a', 'sess-a')
    markUpstreamSessionSuccess('sess-a', 'sess-a-r1')
    expect(recordSessionLimitExceeded('sess-a', 'sess-a-r1')).toBe('sess-a-r2')
    markUpstreamSessionSuccess('sess-a', 'sess-a-r1')
    expect(recordSessionLimitExceeded('sess-a', 'sess-a-r2')).toBeNull()
  })

  test('reuses the current rotation for a concurrent refusal of the previous id', () => {
    expect(recordSessionLimitExceeded('sess-a', 'sess-a')).toBe('sess-a-r1')
    expect(recordSessionLimitExceeded('sess-a', 'sess-a')).toBe('sess-a-r1')
  })

  test('expires an idle rotation when resolving the next request', () => {
    const now = Date.now()
    const clock = spyOn(Date, 'now').mockReturnValue(now)
    try {
      recordSessionLimitExceeded('sess-a', 'sess-a')
      clock.mockReturnValue(now + 6 * 60 * 60 * 1000 + 1)
      expect(getEffectiveUpstreamSessionId('sess-a')).toBe('sess-a')
    } finally { clock.mockRestore() }
  })

  test('isolates the same conversation across providers', () => {
    expect(recordSessionLimitExceeded('sess-a', 'sess-a', 'relay-a')).toBe('sess-a-r1')
    expect(getEffectiveUpstreamSessionId('sess-a', 'relay-a')).toBe('sess-a-r1')
    expect(getEffectiveUpstreamSessionId('sess-a', 'relay-b')).toBe('sess-a')
    recordSessionLimitExceeded('sess-a', 'sess-a-r1', 'relay-a')
    expect(recordSessionLimitExceeded('sess-a', 'sess-a', 'relay-b')).toBe('sess-a-r1')
  })

  test('an empty session id never rotates', () => {
    expect(recordSessionLimitExceeded('', '')).toBeNull()
  })
})

/**
 * Relay-side caps (e.g. OpenCode Zen Go's 100-requests-per-conversation limit)
 * used to strand a healthy conversation: every further request, including
 * /compact, was refused with `400 session_request_limit_exceeded` until the
 * user exported the transcript and started over. The proxy now retries the
 * refused request once under a rotated id, because the request body already
 * carries the full history — only the upstream identity changes.
 */
describe('proxy retries a session-limit refusal under a rotated id', () => {
  let fixture: string
  let previous: string | undefined
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'session-rotation-handler-'))
    previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = fixture
    resetSettingsCache()
    resetSessionRotationForTests()
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    resetSettingsCache()
    resetSessionRotationForTests()
    await rm(fixture, { recursive: true, force: true })
  })

  const LIMIT_BODY = JSON.stringify({
    error: { code: 'session_request_limit_exceeded', message: '当前会话已达到 100 次请求上限，请新开一个会话后继续' },
  })

  async function addRotatingProvider() {
    // opencode-go is the preset whose upstream headers carry `$SESSION_ID`;
    // the anthropic format plus the nested-media opt-out is the smallest way
    // to route a request through the proxy against a mocked upstream.
    return new ProviderService().addProvider({
      presetId: 'opencode-go',
      name: 'Fixture',
      baseUrl: 'https://fixture.invalid',
      apiKey: 'fake-key',
      apiFormat: 'anthropic',
      models: { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' },
      supportsNestedToolResultMedia: false,
    })
  }

  function mockSessionLimitFetch(calls: string[], limitResponses: number) {
    return spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers as HeadersInit)
      calls.push(headers.get('x-opencode-session') ?? '')
      if (calls.length <= limitResponses) {
        return new Response(LIMIT_BODY, { status: 400 })
      }
      // opencode-go's per-model rules make the preset authoritative for the
      // wire format (openai_chat here), so the success response is Chat-style.
      return new Response(JSON.stringify({
        id: 'chatcmpl-fixture',
        object: 'chat.completion',
        created: 0,
        model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  }

  async function sendRequest(providerId: string) {
    const request = new Request(`http://localhost/proxy/providers/${providerId}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'sess-abc' },
      body: JSON.stringify({ model: 'fixture-model', max_tokens: 1024, messages: [{ role: 'user', content: 'fixture' }] }),
    })
    const response = await handleProxyRequest(request, new URL(request.url))
    return { status: response.status, text: await response.text() }
  }

  test('rotates the session id and the retried request succeeds transparently', async () => {
    const provider = await addRotatingProvider()
    const calls: string[] = []
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const fetchMock = mockSessionLimitFetch(calls, 1)
    try {
      const { status, text } = await sendRequest(provider.id)

      expect(status).toBe(200)
      expect(text).toContain('"text":"ok"')
      // First attempt under the inbound id, retry under the rotated one.
      expect(calls).toEqual(['sess-abc', 'sess-abc-r1'])
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })

  test('the next request of the same conversation keeps the rotated id', async () => {
    const provider = await addRotatingProvider()
    const calls: string[] = []
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const fetchMock = mockSessionLimitFetch(calls, 1)
    try {
      await sendRequest(provider.id)
      await sendRequest(provider.id)

      // The rotation persists across requests: no second refusal needed.
      expect(calls).toEqual(['sess-abc', 'sess-abc-r1', 'sess-abc-r1'])
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })

  test('a successful retry can rotate again when its own counter is later exhausted', async () => {
    const provider = await addRotatingProvider()
    const calls: string[] = []
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const fetchMock = mockSessionLimitFetch(calls, 1)
    try {
      expect((await sendRequest(provider.id)).status).toBe(200)
      fetchMock.mockImplementation(async (_url, init) => {
        const id = new Headers(init?.headers).get('x-opencode-session') ?? ''
        calls.push(id)
        if (id.endsWith('-r1')) return new Response(LIMIT_BODY, { status: 400 })
        return Response.json({ id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })
      })
      expect((await sendRequest(provider.id)).status).toBe(200)
      expect(calls).toEqual(['sess-abc', 'sess-abc-r1', 'sess-abc-r1', 'sess-abc-r2'])
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })

  test('a relay that refuses the rotated id too is left alone afterwards', async () => {
    const provider = await addRotatingProvider()
    const calls: string[] = []
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    // Every attempt hits the cap: rotation cannot help this relay.
    const fetchMock = mockSessionLimitFetch(calls, Number.POSITIVE_INFINITY)
    try {
      const first = await sendRequest(provider.id)
      expect(first.status).toBe(400)
      expect(first.text).toContain('session_request_limit_exceeded')
      expect(calls).toEqual(['sess-abc', 'sess-abc-r1'])

      // The next request still probes the rotated id once — that refusal is
      // what marks rotation as useless for this relay.
      const second = await sendRequest(provider.id)
      expect(second.status).toBe(400)
      expect(calls).toEqual(['sess-abc', 'sess-abc-r1', 'sess-abc-r1'])

      // From then on the inbound id passes through with no retry paid.
      const third = await sendRequest(provider.id)
      expect(third.status).toBe(400)
      expect(calls).toEqual(['sess-abc', 'sess-abc-r1', 'sess-abc-r1', 'sess-abc'])
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })

  test('a preset without a session placeholder never rotates', async () => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Fixture',
      baseUrl: 'https://fixture.invalid',
      apiKey: 'fake-key',
      apiFormat: 'anthropic',
      models: { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' },
      supportsNestedToolResultMedia: false,
    })
    const calls: string[] = []
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const fetchMock = mockSessionLimitFetch(calls, Number.POSITIVE_INFINITY)
    try {
      const { status } = await sendRequest(provider.id)

      // The relay identifies conversations by something the proxy does not
      // control here; rotating nothing and retrying would only double traffic.
      expect(status).toBe(400)
      expect(calls).toEqual([''])
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })

  test('does not rotate when an unrelated 400 only mentions the session-limit code', async () => {
    const provider = await addRotatingProvider()
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: { code: 'invalid_request_error', message: 'Parameter session_request_limit_exceeded is not supported' } }, { status: 400 }))
    try {
      expect((await sendRequest(provider.id)).status).toBe(400)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(getEffectiveUpstreamSessionId('sess-abc')).toBe('sess-abc')
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })

  test('an unrelated 400 from a session-aware relay is passed through untouched', async () => {
    const provider = await addRotatingProvider()
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad parameter' } }), { status: 400 })
    })
    try {
      const request = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'sess-abc' },
        body: JSON.stringify({ model: 'fixture-model', max_tokens: 1024, messages: [{ role: 'user', content: 'fixture' }] }),
      })
      const response = await handleProxyRequest(request, new URL(request.url))
      const text = await response.text()

      expect(response.status).toBe(400)
      expect(text).toContain('bad parameter')
      expect(text).not.toContain('session_request_limit_exceeded')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // No rotation was recorded, so nothing changes for the next request.
      expect(getEffectiveUpstreamSessionId('sess-abc')).toBe('sess-abc')
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })
})
