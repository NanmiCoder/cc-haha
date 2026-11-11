import { describe, expect, test } from 'bun:test'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { FetchAdapter, FetchResponse } from './client'
import {
  base64Url,
  hmacSha256,
  locate,
  locatorId,
  parseLocatorHints,
  sha256,
  sha256Hex,
  verifyHostUrlPush,
  verifyLocate,
} from './relocate'

// Vectors are computed independently with node:crypto, never with the code under test.
const T = 'native_fixture-credential-0123456789abcdef'
const H = createHash('sha256').update(T, 'utf8').digest('hex')
const ID = createHash('sha256').update(H, 'utf8').digest('hex')
const sign = (text: string, credential = T) =>
  createHmac('sha256', createHash('sha256').update(credential, 'utf8').digest('hex'))
    .update(text, 'utf8')
    .digest('base64url')
const locateMac = (nonce: string, url: string, credential = T) =>
  sign(`cc-haha-locate\n${nonce}\n${url}`, credential)
const pushMac = (url: string, credential = T) => sign(`cc-haha-host-url\n${url}`, credential)
const NEW_URL = 'https://new-tunnel.trycloudflare.com'

describe('hashes and MACs match node:crypto', () => {
  test('SHA-256 across padding boundaries, UTF-8 and multi-block input', () => {
    const inputs = [
      new Uint8Array(0),
      new TextEncoder().encode('abc'),
      new TextEncoder().encode('电脑地址已更新 · cc-haha'),
      ...[55, 56, 63, 64, 65, 119, 120, 127, 128, 1000].map((size) => new Uint8Array(randomBytes(size))),
    ]
    for (const input of inputs)
      expect(Buffer.from(sha256(input)).toString('hex')).toBe(createHash('sha256').update(input).digest('hex'))
    expect(sha256Hex(T)).toBe(H)
  })

  test('HMAC-SHA256 for short, block-sized and long keys', () => {
    const message = new TextEncoder().encode('cc-haha-host-url\nhttps://x.example')
    for (const key of [new Uint8Array(randomBytes(16)), new TextEncoder().encode(H), new Uint8Array(randomBytes(100))])
      expect(Buffer.from(hmacSha256(key, message)).toString('hex')).toBe(createHmac('sha256', key).update(message).digest('hex'))
  })

  test('locator ID is sha256hex(sha256hex(credential)) and base64url has no padding', () => {
    expect(locatorId(T)).toBe(ID)
    const bytes = new Uint8Array(randomBytes(16))
    expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
    expect(base64Url(bytes)).toHaveLength(22)
  })
})

describe('verifying what the computer says', () => {
  const nonce = 'AAAAAAAAAAAAAAAAAAAAAA'

  test('a locate answer is trusted only with the MAC over this nonce and this exact URL', () => {
    expect(verifyLocate(T, nonce, { url: NEW_URL, mac: locateMac(nonce, NEW_URL) })).toBe(NEW_URL)
    // Tampered URL, tampered MAC, a MAC for another nonce (replay) or another phone's credential.
    expect(verifyLocate(T, nonce, { url: 'https://evil.example', mac: locateMac(nonce, NEW_URL) })).toBeNull()
    expect(verifyLocate(T, nonce, { url: NEW_URL, mac: locateMac(nonce, NEW_URL).slice(0, -1) + 'A' })).toBeNull()
    expect(verifyLocate(T, nonce, { url: NEW_URL, mac: locateMac('BBBBBBBBBBBBBBBBBBBBBB', NEW_URL) })).toBeNull()
    expect(verifyLocate(T, nonce, { url: NEW_URL, mac: locateMac(nonce, NEW_URL, 'native_other') })).toBeNull()
    // The push MAC uses another purpose string and cannot stand in for a locate answer.
    expect(verifyLocate(T, nonce, { url: NEW_URL, mac: pushMac(NEW_URL) })).toBeNull()
    for (const body of [null, 'x', {}, { url: NEW_URL }, { url: 1, mac: 'x' }]) expect(verifyLocate(T, nonce, body)).toBeNull()
  })

  test('a correctly signed address is still refused unless it is a bare https origin', () => {
    for (const url of [
      'http://new-tunnel.trycloudflare.com',
      'https://new-tunnel.trycloudflare.com/remote',
      'https://new-tunnel.trycloudflare.com/?x=1',
      'https://new-tunnel.trycloudflare.com/#pair=1',
      'https://user:pass@new-tunnel.trycloudflare.com',
      'ftp://new-tunnel.trycloudflare.com',
      'not a url',
    ]) {
      expect(verifyLocate(T, nonce, { url, mac: locateMac(nonce, url) })).toBeNull()
      expect(verifyHostUrlPush(T, { url, mac: pushMac(url) })).toBeNull()
    }
    // A trailing slash is the same origin.
    expect(verifyHostUrlPush(T, { url: `${NEW_URL}/`, mac: pushMac(`${NEW_URL}/`) })).toBe(NEW_URL)
  })

  test('a pushed address is trusted only with its own MAC', () => {
    expect(verifyHostUrlPush(T, { url: NEW_URL, mac: pushMac(NEW_URL) })).toBe(NEW_URL)
    expect(verifyHostUrlPush(T, { url: 'https://evil.example', mac: pushMac(NEW_URL) })).toBeNull()
    expect(verifyHostUrlPush(T, { url: NEW_URL, mac: pushMac(NEW_URL, 'native_other') })).toBeNull()
    expect(verifyHostUrlPush(T, { url: NEW_URL, mac: locateMac('', NEW_URL) })).toBeNull()
    expect(verifyHostUrlPush('', { url: NEW_URL, mac: pushMac(NEW_URL, '') })).toBeNull()
    expect(verifyHostUrlPush(T, { url: NEW_URL, mac: undefined })).toBeNull()
  })

  test('locator hints keep only usable IPv4 addresses', () => {
    expect(parseLocatorHints({
      port: 3456,
      addresses: ['192.168.1.8', '10.0.0.2', '192.168.1.8', '127.0.0.1', '0.0.0.0', '224.0.0.1', '192.168.01.8',
        '256.1.1.1', 'fe80::1', 'desk.local', 7, null, '100.64.1.2'],
    })).toEqual({ port: 3456, addresses: ['192.168.1.8', '10.0.0.2', '100.64.1.2'] })
    expect(parseLocatorHints({ port: 3456, addresses: Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`) })?.addresses).toHaveLength(8)
    for (const value of [null, {}, { port: 0, addresses: [] }, { port: 70000, addresses: [] }, { port: 1.5, addresses: [] }, { port: 3456 }, { port: '3456', addresses: [] }])
      expect(parseLocatorHints(value)).toBeNull()
  })
})

type Responder = (url: URL, init: Parameters<FetchAdapter>[1]) => Promise<FetchResponse>
const json = (body: unknown, status = 200): FetchResponse => ({
  ok: status >= 200 && status < 300, status, url: '', redirected: false, text: async () => JSON.stringify(body),
})
function lan(responders: Record<string, Responder>) {
  const requests: { url: string; init: Parameters<FetchAdapter>[1] }[] = []
  const fetch: FetchAdapter = async (input, init) => {
    requests.push({ url: input, init })
    const url = new URL(input)
    const responder = responders[url.hostname]
    if (!responder) throw new TypeError('Network request failed')
    return responder(url, init)
  }
  return { fetch, requests }
}
const never = (_url: URL, init: Parameters<FetchAdapter>[1]) =>
  new Promise<FetchResponse>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let counter = 0
const random = (count: number) => new Uint8Array(count).fill(++counter)

describe('locating the computer on the local network', () => {
  test('asks every hinted address at once and takes the verified answer, not a wrong-MAC responder', async () => {
    const { fetch, requests } = lan({
      // Answers first, but with a MAC it cannot make without this phone's credential.
      '192.168.1.20': async (url) => json({ url: 'https://evil.example', mac: locateMac(url.searchParams.get('nonce')!, 'https://evil.example', 'native_guess') }),
      '192.168.1.8': async (url) => {
        await delay(20)
        return json({ url: NEW_URL, mac: locateMac(url.searchParams.get('nonce')!, NEW_URL) })
      },
      '10.0.0.5': never,
    })
    const result = await locate({
      hints: { port: 3456, addresses: ['192.168.1.20', '192.168.1.8', '10.0.0.5', 'fe80::1', 'desk.local'] },
      credential: T, fetch, random, timeoutMs: 1000,
    })
    expect(result).toBe(NEW_URL)
    // Malformed addresses are skipped; the three valid ones are asked in parallel.
    expect(requests.map((request) => new URL(request.url).host).sort()).toEqual(['10.0.0.5:3456', '192.168.1.20:3456', '192.168.1.8:3456'])
    const nonces = new Set<string>()
    for (const { url, init } of requests) {
      const parsed = new URL(url)
      expect(parsed.protocol).toBe('http:')
      expect(parsed.pathname).toBe('/api/public-access/locate')
      expect(parsed.searchParams.get('id')).toBe(ID)
      expect(parsed.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{22}$/)
      nonces.add(parsed.searchParams.get('nonce')!)
      expect(init.method).toBe('GET')
      expect(init.credentials).toBe('omit')
      expect(Object.keys(init.headers).map((name) => name.toLowerCase())).not.toContain('authorization')
      expect(Object.keys(init.headers).map((name) => name.toLowerCase())).not.toContain('origin')
      // Neither the credential nor its MAC key ever leaves the phone.
      const sent = url + JSON.stringify(init.headers)
      expect(sent).not.toContain(T)
      expect(sent).not.toContain(H)
    }
    expect(nonces.size).toBe(3)
    // The winner releases the still-pending request.
    expect(requests.find((request) => request.url.includes('10.0.0.5'))!.init.signal.aborted).toBe(true)
  })

  test('null when nobody verifies: wrong MAC, errors, 404/429, garbage or silence until the timeout', async () => {
    const { fetch } = lan({
      '192.168.1.2': async (url) => json({ url: NEW_URL, mac: locateMac(url.searchParams.get('nonce')!, NEW_URL, 'native_other') }),
      '192.168.1.3': async () => json({ error: 'not found' }, 404),
      '192.168.1.4': async (url) => json({ url: NEW_URL, mac: locateMac(url.searchParams.get('nonce')!, NEW_URL) }, 429),
      '192.168.1.5': async () => ({ ...json(null), text: async () => '<html>' }),
      '192.168.1.6': never,
    })
    const started = Date.now()
    expect(await locate({
      hints: { port: 3456, addresses: ['192.168.1.1', '192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5', '192.168.1.6'] },
      credential: T, fetch, random, timeoutMs: 50,
    })).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('an answer replayed from another request does not verify', async () => {
    const recorded = locateMac('AQEBAQEBAQEBAQEBAQEBAQ', NEW_URL)
    const { fetch } = lan({ '192.168.1.8': async () => json({ url: NEW_URL, mac: recorded }) })
    expect(await locate({ hints: { port: 3456, addresses: ['192.168.1.8'] }, credential: T, fetch, random: () => new Uint8Array(16).fill(2) })).toBeNull()
  })

  test('nothing is sent without addresses or a credential', async () => {
    const { fetch, requests } = lan({})
    expect(await locate({ hints: { port: 3456, addresses: [] }, credential: T, fetch, random })).toBeNull()
    expect(await locate({ hints: { port: 3456, addresses: ['192.168.1.8'] }, credential: '', fetch, random })).toBeNull()
    expect(requests).toHaveLength(0)
  })
})
