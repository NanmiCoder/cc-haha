import { afterEach, describe, expect, it } from 'bun:test'
import {
  cancelWecomQrLogin,
  pollWecomQrLogin,
  resetWecomQrLoginsForTest,
  startWecomQrLogin,
} from '../qr-auth.js'

type Call = { url: URL }

function fakeFetch(bodies: Array<Record<string, unknown>>, calls: Call[] = []) {
  let index = 0
  const impl = (async (input: string | URL | Request) => {
    calls.push({ url: new URL(String(input)) })
    const body = bodies[Math.min(index, bodies.length - 1)]
    index += 1
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const GENERATED = {
  data: { scode: 'scode-1', auth_url: 'https://work.weixin.qq.com/ai/qc/confirm?scode=scode-1' },
}

afterEach(() => {
  resetWecomQrLoginsForTest()
})

describe('startWecomQrLogin', () => {
  it('requests a code for this platform and returns the scannable URL', async () => {
    const { impl, calls } = fakeFetch([GENERATED])

    const started = await startWecomQrLogin({ fetchImpl: impl, sessionKey: 'k1' })

    expect(calls[0]!.url.pathname).toBe('/ai/qc/generate')
    expect(calls[0]!.url.searchParams.get('source')).toBe('claude-code-haha')
    expect(['1', '2', '3']).toContain(calls[0]!.url.searchParams.get('plat'))
    expect(started.verificationUrl).toBe(GENERATED.data.auth_url)
    expect(started.expiresAt).toBeGreaterThan(Date.now())
  })

  it('reuses a fresh code instead of burning a new one', async () => {
    const { impl, calls } = fakeFetch([GENERATED])

    await startWecomQrLogin({ fetchImpl: impl, sessionKey: 'k1' })
    await startWecomQrLogin({ fetchImpl: impl, sessionKey: 'k1' })

    expect(calls).toHaveLength(1)
  })

  it('forces a new code when the caller asks to rebind', async () => {
    const { impl, calls } = fakeFetch([GENERATED])

    await startWecomQrLogin({ fetchImpl: impl, sessionKey: 'k1' })
    await startWecomQrLogin({ fetchImpl: impl, sessionKey: 'k1', force: true })

    expect(calls).toHaveLength(2)
  })

  // The URL is rendered as a QR code, so anything off the console's own origin
  // must fail closed rather than be shown to the user.
  it.each([
    ['http://work.weixin.qq.com/ai/qc/confirm', 'plain http'],
    ['https://evil.example.com/ai/qc/confirm', 'foreign host'],
    ['https://user:pw@work.weixin.qq.com/x', 'embedded credentials'],
  ])('rejects an unsafe auth_url: %s (%s)', async (authUrl) => {
    const { impl } = fakeFetch([{ data: { scode: 's', auth_url: authUrl } }])

    await expect(startWecomQrLogin({ fetchImpl: impl })).rejects.toThrow(/invalid data/i)
  })

  it('rejects a response with no scan code', async () => {
    const { impl } = fakeFetch([{ data: { auth_url: GENERATED.data.auth_url } }])

    await expect(startWecomQrLogin({ fetchImpl: impl })).rejects.toThrow(/invalid data/i)
  })
})

describe('pollWecomQrLogin', () => {
  async function started(pollBodies: Array<Record<string, unknown>>) {
    const { impl } = fakeFetch([GENERATED, ...pollBodies])
    const start = await startWecomQrLogin({ fetchImpl: impl, sessionKey: 'poll-key' })
    return { sessionKey: start.sessionKey, impl }
  }

  it('returns the bot credentials on success', async () => {
    const { sessionKey, impl } = await started([
      { data: { status: 'success', bot_info: { botid: 'bot-1', secret: 'secret-1' } } },
    ])

    expect(await pollWecomQrLogin({ sessionKey, fetchImpl: impl })).toEqual({
      connected: true,
      botId: 'bot-1',
      secret: 'secret-1',
    })
  })

  it('treats a success with missing credentials as a failure', async () => {
    const { sessionKey, impl } = await started([{ data: { status: 'success', bot_info: {} } }])

    expect(await pollWecomQrLogin({ sessionKey, fetchImpl: impl })).toMatchObject({
      connected: false,
      status: 'failed',
    })
  })

  it('keeps waiting on an unknown intermediate status', async () => {
    const { sessionKey, impl } = await started([{ data: { status: 'scanned' } }])

    expect(await pollWecomQrLogin({ sessionKey, fetchImpl: impl })).toMatchObject({
      connected: false,
      status: 'waiting',
    })
  })

  it.each([
    ['expired', 'expired'],
    ['timeout', 'expired'],
    ['fail', 'failed'],
    ['error', 'failed'],
  ])('maps %s to %s and ends the attempt', async (remote, expected) => {
    const { sessionKey, impl } = await started([{ data: { status: remote } }])

    expect(await pollWecomQrLogin({ sessionKey, fetchImpl: impl })).toMatchObject({ status: expected })
    expect(await pollWecomQrLogin({ sessionKey, fetchImpl: impl })).toMatchObject({ status: 'not_started' })
  })

  it('reports an unknown session key instead of throwing', async () => {
    const { impl } = fakeFetch([{}])

    expect(await pollWecomQrLogin({ sessionKey: 'missing', fetchImpl: impl })).toMatchObject({
      status: 'not_started',
    })
  })

  it('stops polling after the attempt is cancelled', async () => {
    const { sessionKey, impl } = await started([{ data: { status: 'scanned' } }])

    cancelWecomQrLogin(sessionKey)

    expect(await pollWecomQrLogin({ sessionKey, fetchImpl: impl })).toMatchObject({
      status: 'not_started',
    })
  })
})
