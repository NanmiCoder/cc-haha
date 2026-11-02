import { expect, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer, connect, type IncomingHttpHeaders } from 'node:http2'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DirectMobilePushTransport } from './mobilePushTransport.js'

test('APNs HTTP/2 transport signs ES256 and uses the dedicated Live Activity topic', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'apns-wire-'))
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const keyPath = path.join(directory, 'fixture.p8')
  writeFileSync(keyPath, key.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  const calls: { headers: IncomingHttpHeaders; body: string }[] = []
  let status = 200
  const server = createServer()
  server.on('stream', (stream, headers) => {
    let body = ''
    stream.on('data', chunk => { body += chunk })
    stream.on('end', () => { calls.push({ headers, body }); stream.respond({ ':status': status }); stream.end(status === 410 ? JSON.stringify({ reason: 'Unregistered' }) : '') })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const origins: string[] = []
  const transport = new DirectMobilePushTransport({ CC_HAHA_APNS_KEY_PATH: keyPath, CC_HAHA_APNS_KEY_ID: 'FIXTUREKEY', CC_HAHA_APNS_TEAM_ID: 'FIXTURETEAM', CC_HAHA_APNS_TOPIC: 'app.fixture.mobile', CC_HAHA_APNS_SANDBOX: 'true' }, { connect: origin => { origins.push(origin); return connect(`http://127.0.0.1:${address.port}`) } })
  try {
    expect(await transport.send({ platform: 'ios', kind: 'liveActivity', token: 'a'.repeat(64), payload: { aps: { event: 'update', 'content-state': { name: 'CCHahaTaskActivity', props: '{}' } } } })).toBe('sent')
    expect(origins).toEqual(['https://api.sandbox.push.apple.com'])
    expect(calls[0]?.headers['apns-topic']).toBe('app.fixture.mobile.push-type.liveactivity')
    expect(calls[0]?.headers['apns-push-type']).toBe('liveactivity')
    const jwt = String(calls[0]?.headers.authorization).slice(7).split('.')
    expect(verify('sha256', Buffer.from(jwt.slice(0, 2).join('.')), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2]!, 'base64url'))).toBe(true)
    expect(JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString()).iss).toBe('FIXTURETEAM')
    status = 410
    expect(await transport.send({ platform: 'ios', kind: 'notification', token: 'a'.repeat(64), payload: { aps: { alert: 'fixture' } } })).toBe('invalidToken')
    expect(calls[1]?.headers['apns-topic']).toBe('app.fixture.mobile')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }) }
})

test('FCM exchanges explicit service-account JWT and posts v1 notification/data only to fixed Google endpoints', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fcm-wire-'))
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPath = path.join(directory, 'fixture.json')
  writeFileSync(keyPath, JSON.stringify({ type: 'service_account', client_email: 'fixture@example.test', project_id: 'fixture-project', private_key: key.privateKey.export({ format: 'pem', type: 'pkcs8' }) }))
  const calls: { url: string; init: RequestInit; body: string }[] = []
  let invalid = false
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => {
    if (new URL(req.url).pathname === '/token') return Response.json({ access_token: 'fixture-access-token' })
    return invalid ? Response.json({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 }) : Response.json({ name: 'fixture-message' })
  } })
  const transport = new DirectMobilePushTransport({ GOOGLE_APPLICATION_CREDENTIALS: keyPath }, { fetch: async (url, init) => {
    calls.push({ url, init, body: String(init.body) })
    return fetch(`http://127.0.0.1:${server.port}/${url.includes('oauth2') ? 'token' : 'send'}`, init)
  } })
  try {
    const delivery = { platform: 'android' as const, kind: 'notification' as const, token: 'fixture-device-token'.repeat(3), payload: { notification: { title: 'fixture', body: 'ready' }, data: { hostId: 'a', sessionId: 's' }, android: { priority: 'high', notification: { channel_id: 'cc-haha' } } } }
    expect(await transport.send(delivery)).toBe('sent')
    expect(calls.map(call => call.url)).toEqual(['https://oauth2.googleapis.com/token', 'https://fcm.googleapis.com/v1/projects/fixture-project/messages:send'])
    expect(calls.every(call => call.init.redirect === 'error')).toBe(true)
    const jwt = new URLSearchParams(calls[0]!.body).get('assertion')!.split('.')
    expect(verify('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), key.publicKey, Buffer.from(jwt[2]!, 'base64url'))).toBe(true)
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ message: { token: delivery.token, data: { hostId: 'a', sessionId: 's' } } })
    invalid = true
    expect(await transport.send(delivery)).toBe('invalidToken')
  } finally { await server.stop(true); rmSync(directory, { recursive: true, force: true }) }
})

test('missing explicit provider config never searches user credentials or starts a request', async () => {
  let requests = 0
  const transport = new DirectMobilePushTransport({}, { fetch: async () => { requests++; return Response.json({}) } })
  expect(transport.configured('ios')).toBe(false)
  expect(transport.configured('android')).toBe(false)
  await expect(transport.send({ platform: 'android', kind: 'notification', token: 'fixture', payload: {} })).rejects.toThrow('not configured')
  expect(requests).toBe(0)
})
