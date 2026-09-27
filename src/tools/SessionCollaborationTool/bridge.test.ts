import { afterEach, describe, expect, test } from 'bun:test'
import { callSessionBridge, isSessionBridgeAvailable } from './bridge.js'

const keys = ['CC_HAHA_DESKTOP_SERVER_URL', 'CC_HAHA_SESSION_COLLABORATION_TOKEN', 'CC_HAHA_SESSION_ID'] as const
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
afterEach(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] } })

function configure(url: string) {
  process.env.CC_HAHA_DESKTOP_SERVER_URL = url
  process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'fixture-token'
  process.env.CC_HAHA_SESSION_ID = 'fixture-session'
}

describe('desktop session bridge', () => {
  test('requires complete configuration and refuses external hosts', async () => {
    for (const key of keys) delete process.env[key]
    expect(isSessionBridgeAvailable()).toBe(false)
    configure('https://example.com')
    expect(isSessionBridgeAvailable()).toBe(false)
    await expect(callSessionBridge('list', {})).rejects.toThrow('loopback')
  })

  test('authenticates loopback requests and forwards data', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      expect(new URL(request.url).pathname).toBe('/api/session-collaboration/send')
      expect(request.headers.get('authorization')).toBe('Bearer fixture-token')
      expect(request.headers.get('x-session-id')).toBe('fixture-session')
      expect(await request.json()).toEqual({ targetSessionId: 'peer', content: 'hello' })
      return Response.json({ status: 'queued', id: 'message' })
    } })
    try {
      configure(server.url.origin)
      expect(await callSessionBridge('send', { targetSessionId: 'peer', content: 'hello' })).toEqual({ status: 'queued', id: 'message' })
    } finally { server.stop(true) }
  })

  test('never follows redirects or exposes error response bodies', async () => {
    let redirect = true
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      return redirect ? Response.redirect('https://example.com') : new Response('private server text', { status: 403 })
    } })
    try {
      configure(server.url.origin)
      await expect(callSessionBridge('read', {})).rejects.toThrow()
      redirect = false
      await expect(callSessionBridge('read', {})).rejects.toThrow('Session collaboration read failed (403)')
    } finally { server.stop(true) }
  })

  test('preserves actionable structured conflict details', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      return Response.json({ error: 'CONFLICT', message: 'Session creation is pending or requires recovery' }, { status: 409 })
    } })
    try {
      configure(server.url.origin)
      await expect(callSessionBridge('create', {})).rejects.toThrow('requires recovery')
    } finally { server.stop(true) }
  })
})
