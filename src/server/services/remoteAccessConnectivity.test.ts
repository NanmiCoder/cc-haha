import { describe, expect, test } from 'bun:test'
import { resolveRemoteAccessProxy, verifyRemoteAccessGateway } from './remoteAccessConnectivity.js'
import type { NetworkSettings } from './networkSettings.js'

const direct = async (): Promise<NetworkSettings> => ({ aiRequestTimeoutMs: 30000, proxy: { mode: 'direct', url: '' } })
describe('remote access connectivity', () => {
  test('uses the existing saved proxy policy for both tunnel setup and the public probe', async () => {
    const settings = async (): Promise<NetworkSettings> => ({ aiRequestTimeoutMs: 30000, proxy: { mode: 'manual', url: 'http://fixture:fake@127.0.0.1:12345' } })
    expect(await resolveRemoteAccessProxy({ settings })).toEqual({ proxyUrl: 'http://fixture:fake@127.0.0.1:12345' })
    expect(await resolveRemoteAccessProxy({ settings: direct })).toEqual({ proxyUrl: null })
    const calls: unknown[] = []
    const fakeFetch = (async (url: unknown, init: unknown) => {
      calls.push([String(url), init])
      return Response.json({ status: 'ok', gatewayId: 'fixture-gateway' })
    }) as typeof fetch
    expect(await verifyRemoteAccessGateway('https://phone.example.test', 'fixture-gateway', { settings, fetch: fakeFetch })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject(['https://phone.example.test/health', { method: 'GET', redirect: 'manual', proxy: 'http://fixture:fake@127.0.0.1:12345' }])
  })

  test('requires this gateway identity, rejects redirects and bounds the response', async () => {
    for (const response of [
      Response.json({ status: 'ok', gatewayId: 'another-gateway' }),
      Response.json({ status: 'ok' }),
      new Response('<html>Cloudflare error</html>', { headers: { 'Content-Type': 'text/html' } }),
      new Response(null, { status: 302, headers: { Location: 'https://other.example.test' } }),
      Response.json({ status: 'ok', gatewayId: 'fixture', padding: 'x'.repeat(5000) }),
    ]) {
      expect(await verifyRemoteAccessGateway('https://phone.example.test', 'fixture', { settings: direct, fetch: (async () => response) as typeof fetch })).toBe(false)
    }
    let called = false
    expect(await verifyRemoteAccessGateway('http://phone.example.test', 'fixture', { settings: direct, fetch: (async () => { called = true; return Response.json({}) }) as typeof fetch })).toBe(false)
    expect(called).toBe(false)
  })
})
