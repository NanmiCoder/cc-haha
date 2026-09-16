/**
 * Feishu scan-to-create provisioning — protocol round-trip.
 *
 * These tests pin the wire contract we implement against Feishu's device
 * authorization endpoint: what `begin` must send, what the QR URL must and must
 * not carry, and how every RFC 8628 poll outcome maps onto our status. The
 * fetch implementation is injected, so nothing here touches the network.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import {
  assertFeishuVerificationUrl,
  beginFeishuRegistration,
  encodeFeishuAddons,
  FEISHU_REQUIRED_CALLBACKS,
  FEISHU_REQUIRED_EVENTS,
  FEISHU_REQUIRED_SCOPES,
  pollFeishuRegistration,
  resetFeishuRegistrationsForTest,
} from '../registration.js'

type Call = { url: string; params: Record<string, string> }

function fakeFetch(responses: Array<Record<string, unknown>>, calls: Call[] = []) {
  let index = 0
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))
    calls.push({ url, params })
    const body = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(JSON.stringify(body), {
      status: (body as { error?: string }).error ? 400 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const BEGIN_OK = {
  device_code: 'device-123',
  verification_uri_complete: 'https://open.feishu.cn/page/launcher?code=abc',
  expires_in: 600,
  interval: 5,
}

afterEach(() => {
  resetFeishuRegistrationsForTest()
})

describe('beginFeishuRegistration', () => {
  it('asks for a personal-agent app with a client secret', async () => {
    const { impl, calls } = fakeFetch([BEGIN_OK])

    await beginFeishuRegistration({ fetchImpl: impl })

    expect(calls[0]!.url).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
    expect(calls[0]!.params).toEqual({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    })
  })

  it('pins the QR URL to create-only and carries the scopes this adapter calls', async () => {
    const { impl } = fakeFetch([BEGIN_OK])

    const begun = await beginFeishuRegistration({
      fetchImpl: impl,
      appName: 'Claude Code Haha',
      appDescription: 'desc',
    })

    const url = new URL(begun.verificationUri)
    // createOnly is the guard that stops this flow from silently rewriting the
    // configuration of a bot the user already runs.
    expect(url.searchParams.get('createOnly')).toBe('true')
    expect(url.searchParams.get('name')).toBe('Claude Code Haha')
    expect(url.searchParams.get('desc')).toBe('desc')
    expect(url.searchParams.has('clientID')).toBe(false)

    const addons = JSON.parse(decodeAddons(url.searchParams.get('addons')!))
    expect(addons.preset).toBe(false)
    expect(addons.scopes.tenant).toEqual([...FEISHU_REQUIRED_SCOPES])
    expect(addons.events.items.tenant).toEqual([...FEISHU_REQUIRED_EVENTS])
    expect(addons.callbacks.items).toEqual([...FEISHU_REQUIRED_CALLBACKS])
  })

  it('falls back to platform defaults when expiry and interval are missing', async () => {
    const { impl } = fakeFetch([{ device_code: 'd', verification_uri_complete: BEGIN_OK.verification_uri_complete }])

    const begun = await beginFeishuRegistration({ fetchImpl: impl })

    expect(begun.expiresInSeconds).toBe(600)
    expect(begun.intervalSeconds).toBe(5)
  })

  it('starts on the Lark account domain when asked', async () => {
    const { impl, calls } = fakeFetch([BEGIN_OK])

    await beginFeishuRegistration({ fetchImpl: impl, domain: 'lark' })

    expect(calls[0]!.url.startsWith('https://accounts.larksuite.com/')).toBe(true)
  })

  it('rejects a begin response with no device code', async () => {
    const { impl } = fakeFetch([{ verification_uri_complete: BEGIN_OK.verification_uri_complete }])

    await expect(beginFeishuRegistration({ fetchImpl: impl })).rejects.toThrow(/device code/i)
  })
})

describe('assertFeishuVerificationUrl', () => {
  it('accepts the platform launcher hosts', () => {
    expect(assertFeishuVerificationUrl('https://open.feishu.cn/page/launcher?x=1').hostname)
      .toBe('open.feishu.cn')
    expect(assertFeishuVerificationUrl('https://accounts.larksuite.com/x').hostname)
      .toBe('accounts.larksuite.com')
  })

  // The URL becomes a QR code we tell the user to scan, so an off-platform or
  // credentialed host would be a phishing vector wearing our UI.
  it.each([
    ['http://open.feishu.cn/page/launcher', 'plain http'],
    ['https://evil.example.com/page/launcher', 'foreign host'],
    ['https://user:pass@open.feishu.cn/x', 'embedded credentials'],
    ['https://open.feishu.cn:8443/x', 'non-default port'],
    ['not a url', 'unparseable'],
  ])('rejects %s (%s)', (value) => {
    expect(() => assertFeishuVerificationUrl(value)).toThrow()
  })
})

describe('pollFeishuRegistration', () => {
  async function begin(responses: Array<Record<string, unknown>>) {
    const { impl, calls } = fakeFetch([BEGIN_OK, ...responses])
    const begun = await beginFeishuRegistration({ fetchImpl: impl })
    return { sessionKey: begun.sessionKey, impl, calls }
  }

  it('returns the credentials once the platform issues them', async () => {
    const { sessionKey, impl } = await begin([
      { client_id: 'cli_abc', client_secret: 'secret-1', user_info: { open_id: 'ou_1' } },
    ])

    const result = await pollFeishuRegistration({ sessionKey, fetchImpl: impl })

    expect(result).toEqual({
      status: 'success',
      appId: 'cli_abc',
      appSecret: 'secret-1',
      domain: 'feishu',
      openId: 'ou_1',
    })
  })

  it('keeps waiting while the user has not confirmed', async () => {
    const { sessionKey, impl } = await begin([{ error: 'authorization_pending' }])

    const result = await pollFeishuRegistration({ sessionKey, fetchImpl: impl })

    expect(result.status).toBe('waiting')
  })

  it('honours slow_down by widening the poll interval', async () => {
    const { sessionKey, impl } = await begin([{ error: 'slow_down' }])

    const result = await pollFeishuRegistration({ sessionKey, fetchImpl: impl })

    expect(result).toMatchObject({ status: 'waiting', intervalSeconds: 10 })
  })

  it.each([
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
    ['something_else', 'failed'],
  ])('maps %s to %s and ends the attempt', async (error, expected) => {
    const { sessionKey, impl } = await begin([{ error }])

    expect((await pollFeishuRegistration({ sessionKey, fetchImpl: impl })).status).toBe(expected)
    // A terminal outcome must clear the session rather than let the UI keep
    // polling a device code the platform has already retired.
    expect((await pollFeishuRegistration({ sessionKey, fetchImpl: impl })).status).toBe('not_started')
  })

  it('reports an unknown session key instead of throwing', async () => {
    const { impl } = fakeFetch([{}])

    expect((await pollFeishuRegistration({ sessionKey: 'nope', fetchImpl: impl })).status)
      .toBe('not_started')
  })

  it('switches to the Lark domain once for an international tenant', async () => {
    const calls: Call[] = []
    const { impl } = fakeFetch(
      [
        BEGIN_OK,
        { user_info: { tenant_brand: 'lark' }, error: 'authorization_pending' },
        { client_id: 'cli_lark', client_secret: 'secret-lark', user_info: { tenant_brand: 'lark' } },
      ],
      calls,
    )
    const begun = await beginFeishuRegistration({ fetchImpl: impl })

    const result = await pollFeishuRegistration({ sessionKey: begun.sessionKey, fetchImpl: impl })

    expect(result).toMatchObject({ status: 'success', appId: 'cli_lark', domain: 'lark' })
    expect(calls[1]!.url.startsWith('https://accounts.feishu.cn/')).toBe(true)
    expect(calls[2]!.url.startsWith('https://accounts.larksuite.com/')).toBe(true)
  })
})

describe('encodeFeishuAddons', () => {
  it('produces URL-safe unpadded base64 that gunzips back to the payload', () => {
    const payload = { preset: false, scopes: { tenant: ['im:message:send_as_bot'] } }

    const encoded = encodeFeishuAddons(payload)

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(decodeAddons(encoded))).toEqual(payload)
  })
})

function decodeAddons(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return gunzipSync(Buffer.from(padded, 'base64')).toString('utf8')
}
