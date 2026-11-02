import { expect, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer, connect, type IncomingHttpHeaders } from 'node:http2'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DesktopPullTransport, DirectMobilePushTransport, EXPO_PUSH_URL, ExpoPushTransport, MobilePushRouter } from './mobilePushTransport.js'

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

test('Expo relay posts one message per ticket and maps only DeviceNotRegistered to a dead token', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  let reply: () => Response = () => Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] })
  const transport = new ExpoPushTransport({ fetch: async (url, init) => { calls.push({ url, init }); return reply() }, fetchOptions: async () => ({ proxy: 'http://proxy.fixture:7890' }) })
  const delivery = { platform: 'ios' as const, kind: 'notification' as const, provider: 'expo' as const, token: 'ExponentPushToken[fixture]', payload: { title: 'fixture', body: 'ready', categoryId: 'cchahaTool', data: { hostId: 'a' }, to: 'ExponentPushToken[someone-else]' } }
  expect(transport.configured()).toBe(true)
  expect(await transport.send(delivery)).toBe('sent')
  expect(calls[0]?.url).toBe(EXPO_PUSH_URL)
  expect(calls[0]?.init.redirect).toBe('error')
  // The app's network proxy carries the request; it never overrides the safety options.
  expect((calls[0]?.init as Record<string, unknown>).proxy).toBe('http://proxy.fixture:7890')
  expect(calls[0]?.init.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' })
  // The registration's token always wins over anything in the payload.
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual([{ ...delivery.payload, to: delivery.token }])
  reply = () => Response.json({ data: [{ status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }] })
  expect(await transport.send(delivery)).toBe('invalidToken')
  for (const failure of [
    () => Response.json({ data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }] }),
    () => Response.json({ data: [{ status: 'error', details: { error: 'InvalidCredentials' } }] }),
    () => Response.json({ errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' }] }),
    () => new Response('rate limited', { status: 429 }),
    () => new Response('not json'),
  ]) {
    reply = failure
    await expect(transport.send(delivery)).rejects.toThrow('Expo push rejected')
  }
  await expect(transport.send({ ...delivery, kind: 'liveActivity' })).rejects.toThrow('ordinary notifications')
})

test('pulled alerts wait for the phone, wake its long poll and leave once acknowledged', async () => {
  let now = 0
  const transport = new DesktopPullTransport(() => now)
  const signal = new AbortController().signal
  const send = (token: string, body: string) => transport.send({ platform: 'android', kind: 'notification', provider: 'desktop', token, payload: { title: 't', body } })
  expect(await transport.pull('phone-a', undefined, signal, 0)).toEqual([])
  const waiting = transport.pull('phone-a', undefined, signal, 60_000)
  await send('phone-b', 'not yours')
  await send('phone-a', 'first')
  const [first] = await waiting
  // Not toMatchObject(expect.any): Bun 1.3 writes the matcher into the received object.
  expect(first?.body).toBe('first')
  expect(typeof first?.id).toBe('string')
  await send('phone-a', 'second')
  // Unacknowledged alerts are handed out again; the phone dedupes by id.
  expect((await transport.pull('phone-a', undefined, signal, 0)).map(item => item.body)).toEqual(['first', 'second'])
  expect((await transport.pull('phone-a', first!.id, signal, 0)).map(item => item.body)).toEqual(['second'])
  expect((await transport.pull('phone-a', 'unknown-ack', signal, 0)).map(item => item.body)).toEqual(['second'])
  now += 10 * 60_000
  expect(await transport.pull('phone-a', undefined, signal, 0)).toEqual([])
  expect((await transport.pull('phone-b', undefined, signal, 0)).length).toBe(0)
  for (let index = 0; index < 40; index++) await send('phone-c', String(index))
  const kept = await transport.pull('phone-c', undefined, signal, 0)
  expect(kept.map(item => item.body)).toEqual(Array.from({ length: 32 }, (_, index) => String(index + 8)))
  await expect(transport.send({ platform: 'ios', kind: 'liveActivity', token: 'phone-a', payload: {} })).rejects.toThrow('ordinary notifications')
})

test('a disconnected phone releases its long poll without waiting for the hold', async () => {
  const transport = new DesktopPullTransport()
  const controller = new AbortController()
  const started = Date.now()
  const waiting = transport.pull('phone-a', undefined, controller.signal, 60_000)
  controller.abort()
  expect(await waiting).toEqual([])
  expect(Date.now() - started).toBeLessThan(1000)
})

test('the router sends each registration through the provider it chose', async () => {
  const seen: string[] = []
  const fake = (name: string, configured: boolean) => ({ configured: () => configured, send: async () => { seen.push(name); return 'sent' as const } })
  const desktop = new DesktopPullTransport()
  const router = new MobilePushRouter(fake('direct', false), fake('expo', true), desktop)
  expect([router.configured('ios'), router.configured('ios', 'expo'), router.configured('android', 'desktop'), router.configured('ios', 'desktop')]).toEqual([false, true, true, false])
  await router.send({ platform: 'ios', kind: 'notification', token: 't', payload: {} })
  await router.send({ platform: 'ios', kind: 'notification', provider: 'expo', token: 't', payload: {} })
  await router.send({ platform: 'android', kind: 'notification', provider: 'desktop', token: 'phone', payload: { body: 'pulled' } })
  expect(seen).toEqual(['direct', 'expo'])
  expect(await desktop.pull('phone', undefined, new AbortController().signal, 0)).toMatchObject([{ body: 'pulled' }])
})
