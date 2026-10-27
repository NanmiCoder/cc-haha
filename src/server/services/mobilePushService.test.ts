import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MobilePushService, inQuietHours, migrateMobilePushStore, pushEvent, validatePushInput, type MobileActivity, type PushInput } from './mobilePushService.js'
import type { PushDelivery } from './mobilePushTransport.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const input = (extra: Partial<PushInput> = {}): PushInput => ({ platform: 'ios', token: 'a'.repeat(64), hostId: 'local-phone-host-a', preferences: { decisions: true, completed: true, errors: true }, quietHours: { enabled: false, start: '22:00', end: '08:00' }, timeZone: 'Asia/Shanghai', ...extra })
const completed = (at = Date.parse('2026-10-24T04:00:00Z')): MobileActivity => ({ id: 's', activityState: 'idle', terminalOutcome: 'completed', completedAt: at })
function fixture(configured = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'mobile-push-'))
  let activities: MobileActivity[] = [], now = Date.parse('2026-10-24T04:00:00Z'), remoteActive = true
  const sent: PushDelivery[] = []
  const transport = { configured: () => configured, send: async (delivery: PushDelivery): Promise<'sent' | 'invalidToken'> => { sent.push(delivery); return 'sent' } }
  const service = new MobilePushService({ directory, transport, activities: async () => activities, summary: async () => ({ title: 'fixture session' }), now: () => now })
  service.start(() => remoteActive)
  cleanups.push(() => { service.stop(); rmSync(directory, { recursive: true, force: true }) })
  return { service, directory, sent, transport, state: (value: MobileActivity[]) => { activities = value }, advance: (ms: number) => { now += ms }, revoke: () => { remoteActive = false } }
}

test('configuration absence is normal unavailability and never records successful registration', () => {
  const f = fixture(false)
  expect(f.service.status()).toEqual({ status: 'notConfigured', platforms: { ios: false, android: false } })
  expect(f.service.register(input(), {})).toEqual({ registered: false, status: 'notConfigured' })
})

test('registration rejects client ownership, malformed preferences and invalid time zones', () => {
  expect(validatePushInput(input())).toBe(true)
  for (const value of [input({ timeZone: 'not-a-zone' }), { ...input(), owner: 'remote:someone' }, { ...input(), preferences: { decisions: true } }, input({ token: '../secret' }), input({ kind: 'liveActivity', platform: 'android' }), { ...input(), quietHours: { enabled: true, start: '24:00', end: '08:00' } }]) expect(validatePushInput(value)).toBe(false)
})

test('old store migration preserves unknown fields and refuses future schemas', () => {
  expect(migrateMobilePushStore({ version: 0, future: { keep: true }, tokens: ['not-adopted'] })).toEqual({ version: 1, future: { keep: true }, tokens: ['not-adopted'], registrations: [] })
  expect(() => migrateMobilePushStore({ version: 2 })).toThrow()
})

test('tokens are encrypted at rest and ownership requires the verified remote device plus same token', () => {
  const f = fixture()
  writeFileSync(path.join(f.directory, 'mobile-push.json'), JSON.stringify({ version: 0, future: { keep: true } }))
  const registered = f.service.register(input(), { remoteDeviceId: 'device-a' })
  expect(registered.registered).toBe(true)
  expect(JSON.stringify(registered)).not.toContain(input().token)
  const raw = readFileSync(path.join(f.directory, 'mobile-push.json'), 'utf8')
  expect(raw).not.toContain(input().token)
  expect(JSON.parse(raw).future).toEqual({ keep: true })
  expect(statSync(path.join(f.directory, 'mobile-push.json')).mode & 0o777).toBe(0o600)
  expect(f.service.unregister(registered.id!, input().token, { remoteDeviceId: 'device-b' })).toBe(false)
  expect(f.service.unregister(registered.id!, 'b'.repeat(64), { remoteDeviceId: 'device-a' })).toBe(false)
  expect(f.service.unregister(registered.id!, input().token, { remoteDeviceId: 'device-a' })).toBe(true)
})

test('pushes authoritative transitions once and limits quick actions to ordinary pending tools', async () => {
  const f = fixture()
  f.service.register(input(), {})
  f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
  expect(f.sent).toHaveLength(0)
  f.state([{ id: 's', activityState: 'waiting', requestId: 'q1', toolName: 'Bash', preview: '等待工具权限确认' }]); await f.service.tick(); await f.service.tick()
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]?.payload).toMatchObject({ aps: { category: 'cchahaTool' }, hostId: 'local-phone-host-a', sessionId: 's', requestId: 'q1', eventType: 'decision' })
  f.state([{ id: 's', activityState: 'waiting', requestId: 'q2', toolName: 'AskUserQuestion' }]); await f.service.tick()
  expect(f.sent[1]?.payload.aps).toMatchObject({ category: 'cchahaDecision' })
  f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
  f.state([completed()]); await f.service.tick(); await f.service.tick()
  expect(f.sent).toHaveLength(3)
  expect(f.sent[2]?.payload.eventType).toBe('completed')
})

test('revocation and device expiry stop delivery; invalid provider tokens are removed', async () => {
  for (const reason of ['revoke', 'expire', 'invalid'] as const) {
    const f = fixture()
    f.service.register(input(), { remoteDeviceId: 'remote-device', remoteDeviceExpiresAt: Date.parse('2026-10-24T04:00:01Z') })
    if (reason === 'revoke') f.revoke()
    if (reason === 'expire') f.advance(1001)
    if (reason === 'invalid') f.transport.send = async () => 'invalidToken'
    f.state([{ id: 's', activityState: 'waiting', requestId: 'q1', toolName: 'Bash' }]); await f.service.tick()
    expect(f.sent).toHaveLength(0)
    expect(JSON.parse(readFileSync(path.join(f.directory, 'mobile-push.json'), 'utf8')).registrations).toEqual([])
  }
})

test('quiet hours respect timezone and midnight and suppress delivery', async () => {
  const quiet = input({ quietHours: { enabled: true, start: '22:00', end: '08:00' } })
  expect(inQuietHours(quiet, Date.parse('2026-10-24T15:00:00Z'))).toBe(true)
  expect(inQuietHours(quiet, Date.parse('2026-10-24T00:00:00Z'))).toBe(false)
  const f = fixture()
  f.service.register(input({ quietHours: { enabled: true, start: '00:00', end: '23:59' } }), {})
  f.state([{ id: 's', activityState: 'waiting' }]); await f.service.tick()
  expect(f.sent).toHaveLength(0)
})

test('Live Activity uses ActivityKit content state and sends end when its real run completes', async () => {
  const f = fixture()
  f.service.register(input({ kind: 'liveActivity', deviceToken: 'b'.repeat(64), sessionId: 's', activityId: 'activity-a', name: 'CCHahaTaskActivity', hostName: 'Computer A' }), {})
  f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
  const aps = f.sent[0]!.payload.aps as Record<string, unknown>
  expect(aps.event).toBe('update')
  const content = aps['content-state'] as { name: string; props: string }
  expect(content.name).toBe('CCHahaTaskActivity')
  expect(JSON.parse(content.props)).toMatchObject({ hostName: 'Computer A', status: 'running', sessionId: 's' })
  f.state([completed()]); await f.service.tick()
  expect(f.sent[1]?.payload.aps).toMatchObject({ event: 'end' })
  const endContent = (f.sent[1]!.payload.aps as Record<string, unknown>)['content-state'] as { props: string }
  expect(JSON.parse(endContent.props).status).toBe('completed')
  expect(JSON.parse(readFileSync(path.join(f.directory, 'mobile-push.json'), 'utf8')).registrations).toEqual([])
})

test('errors expose no token and do not claim delivery', async () => {
  const f = fixture()
  f.transport.send = async () => { throw new Error(input().token) }
  f.service.register(input(), {})
  f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
  f.state([{ id: 's', activityState: 'failed' }]); await f.service.tick()
  expect(f.service.status().error).toContain('投递失败')
  expect(JSON.stringify(f.service.status())).not.toContain(input().token)
})

test('initial idle and failed snapshots are not fabricated completion events', () => {
  expect(pushEvent(undefined, { id: 's', activityState: 'idle' })).toBeUndefined()
  expect(pushEvent(undefined, { id: 's', activityState: 'failed' })).toBeUndefined()
  expect(pushEvent({ id: 's', activityState: 'waiting' }, { id: 's', activityState: 'idle' })).toBeUndefined()
})

test('completion edges require explicit successful evidence and a changed valid timestamp', () => {
  const previous: MobileActivity = { id: 's', activityState: 'running' }
  for (const current of [
    { id: 's', activityState: 'idle' },
    { id: 's', activityState: 'review' },
    { id: 's', activityState: 'idle', terminalOutcome: 'stopped', completedAt: 100 },
    { id: 's', activityState: 'idle', terminalOutcome: 'failed', completedAt: 100 },
    ...[undefined, NaN, Infinity, 0, -1].map(completedAt => ({ id: 's', activityState: 'idle', terminalOutcome: 'completed', completedAt })),
  ] as MobileActivity[]) expect(pushEvent(previous, current)).not.toBe('completed')
  expect(pushEvent(undefined, completed())).toBeUndefined()
  expect(pushEvent(completed(), completed())).toBeUndefined()
  expect(pushEvent({ id: 's', activityState: 'idle' }, completed())).toBe('completed')
  expect(pushEvent(completed(100), completed(200))).toBe('completed')
})

test('idle, disappearance and stop never send a success notification', async () => {
  for (const terminal of [[], [{ id: 's', activityState: 'idle' }], [{ id: 's', activityState: 'idle', terminalOutcome: 'stopped' }]] as MobileActivity[][]) {
    const f = fixture()
    f.service.register(input(), {})
    f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
    f.state(terminal); await f.service.tick(); await f.service.tick()
    expect(f.sent).toEqual([])
  }
})

test('late durable success sends once after idle while initial historical success only establishes a baseline', async () => {
  const f = fixture()
  f.service.register(input(), {})
  f.state([completed(100)]); await f.service.tick()
  expect(f.sent).toEqual([])
  f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
  f.state([{ id: 's', activityState: 'idle' }]); await f.service.tick()
  expect(f.sent).toEqual([])
  f.state([completed(200)]); await f.service.tick(); await f.service.tick()
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]?.payload.eventType).toBe('completed')
})

test('unknown and stopped Live Activities end without a successful completed card', async () => {
  for (const terminal of [[], [{ id: 's', activityState: 'idle' }], [{ id: 's', activityState: 'idle', terminalOutcome: 'stopped' }]] as MobileActivity[][]) {
    const f = fixture()
    f.service.register(input({ kind: 'liveActivity', deviceToken: 'b'.repeat(64), sessionId: 's', activityId: 'a', name: 'CCHahaTaskActivity' }), {})
    f.state([{ id: 's', activityState: 'waiting', requestId: 'old', toolName: 'Bash' }]); await f.service.tick()
    f.state(terminal); await f.service.tick()
    const aps = f.sent[1]!.payload.aps as Record<string, unknown>
    expect(aps.event).toBe('end')
    const props = JSON.parse((aps['content-state'] as { props: string }).props)
    expect(props.status).not.toBe('completed')
    expect(props.allowUrl).toBeUndefined()
    expect(props.denyUrl).toBeUndefined()
    expect(aps['dismissal-date']).toBe(aps.timestamp)
  }
})

test('a failed completion delivery is cancelled when its successful evidence disappears or is stopped', async () => {
  for (const terminal of [[], [{ id: 's', activityState: 'idle', terminalOutcome: 'stopped' }]] as MobileActivity[][]) {
    const f = fixture()
    let attempts = 0
    f.transport.send = async () => { attempts++; throw new Error('offline') }
    f.service.register(input(), {})
    f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
    f.state([completed()]); await f.service.tick()
    expect(attempts).toBe(1)
    f.state(terminal); f.advance(5000); await f.service.tick()
    expect(attempts).toBe(1)
  }
})


test('revocation during summary lookup prevents any send and shutdown drains pending work', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'push-race-'))
  let resolve!: (value: { title: string }) => void
  let entered!: () => void
  const summaryStarted = new Promise<void>(done => { entered = done })
  let active = true
  const sent: PushDelivery[] = []
  const service = new MobilePushService({ directory, transport: { configured: () => true, send: async delivery => { sent.push(delivery); return 'sent' } }, activities: () => [{ id: 's', activityState: 'waiting' }], summary: () => new Promise(done => { resolve = done; entered() }) })
  service.start(() => active)
  try {
    service.register(input(), { remoteDeviceId: 'device' })
    const pending = service.tick()
    await summaryStarted
    active = false
    const stopped = service.stop()
    resolve({ title: 'session' })
    await Promise.all([pending, stopped])
    expect(sent).toEqual([])
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }) }
})

test('v1 registration extensions survive reload and re-registration', () => {
  const f = fixture()
  const registered = f.service.register(input(), {})
  const file = path.join(f.directory, 'mobile-push.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  stored.registrations[0].future = { keep: true }
  writeFileSync(file, JSON.stringify(stored))
  const next = new MobilePushService({ directory: f.directory, transport: f.transport, activities: () => [], summary: async () => null })
  expect(next.register(input(), {}).id).toBe(registered.id)
  expect(JSON.parse(readFileSync(file, 'utf8')).registrations[0].future).toEqual({ keep: true })
  void next.stop()
})


test('device unregister removes only its ordinary and linked Live Activity tokens and is idempotent', () => {
  const f = fixture()
  const ordinary = input()
  f.service.register(ordinary, {})
  f.service.register(input({ token: 'b'.repeat(64), deviceToken: ordinary.token, kind: 'liveActivity', sessionId: 's', activityId: 'a', name: 'CCHahaTaskActivity' }), {})
  f.service.register(input({ token: 'c'.repeat(64), hostId: 'other-phone' }), {})
  expect(f.service.unregisterDevice(ordinary.token, 'wrong-host', {})).toBe(0)
  expect(f.service.unregisterDevice(ordinary.token, ordinary.hostId, { remoteDeviceId: 'wrong-owner' })).toBe(0)
  expect(f.service.unregisterDevice(ordinary.token, ordinary.hostId, {})).toBe(2)
  expect(f.service.unregisterDevice(ordinary.token, ordinary.hostId, {})).toBe(0)
  const stored = JSON.parse(readFileSync(path.join(f.directory, 'mobile-push.json'), 'utf8'))
  expect(stored.registrations.map((row: { hostId: string }) => row.hostId)).toEqual(['other-phone'])
  expect(JSON.stringify(stored)).not.toContain(ordinary.token)
})

test('a LAN Live Activity can unregister itself using its own token without touching the parent device', () => {
  const f = fixture()
  const ordinary = f.service.register(input(), {})
  const activityToken = 'b'.repeat(64)
  const activity = f.service.register(input({ token: activityToken, deviceToken: input().token, kind: 'liveActivity', sessionId: 's', activityId: 'a', name: 'CCHahaTaskActivity' }), {})
  expect(f.service.unregister(activity.id!, input().token, {})).toBe(false)
  expect(f.service.unregister(activity.id!, activityToken, { remoteDeviceId: 'wrong-owner' })).toBe(false)
  expect(f.service.unregister(activity.id!, activityToken, {})).toBe(true)
  expect(JSON.parse(readFileSync(path.join(f.directory, 'mobile-push.json'), 'utf8')).registrations.map((row: { id: string }) => row.id)).toEqual([ordinary.id])
})

test('transient delivery failure retries the same pending decision once without replaying a replaced request', async () => {
  const f = fixture()
  let attempts = 0
  f.transport.send = async delivery => { attempts++; if (attempts === 1) throw new Error('temporary network failure'); f.sent.push(delivery); return 'sent' }
  f.service.register(input(), {})
  f.state([{ id: 's', activityState: 'waiting', requestId: 'still-pending', toolName: 'Bash' }])
  await f.service.tick()
  expect(attempts).toBe(1)
  await f.service.tick()
  expect(attempts).toBe(1)
  f.advance(5000); await f.service.tick(); await f.service.tick()
  expect(attempts).toBe(2)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]?.payload.requestId).toBe('still-pending')
  f.transport.send = async () => { attempts++; throw new Error('offline') }
  f.state([{ id: 's', activityState: 'waiting', requestId: 'old-request', toolName: 'Bash' }]); await f.service.tick()
  f.advance(6000); f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
  expect(attempts).toBe(3)
})

test('completion retries retain explicit durable evidence; stalled work sends one error edge', async () => {
  const f = fixture()
  let attempts = 0
  f.transport.send = async delivery => { attempts++; if (attempts === 1) throw new Error('offline'); f.sent.push(delivery); return 'sent' }
  f.service.register(input(), {})
  f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
  f.state([completed()]); await f.service.tick()
  f.advance(5000); await f.service.tick()
  expect(f.sent[0]?.payload.eventType).toBe('completed')
  f.state([{ id: 's', activityState: 'running', stalled: true }]); await f.service.tick(); await f.service.tick()
  expect(f.sent[1]?.payload.aps).toMatchObject({ alert: { body: '超过 5 分钟没有进展，请打开查看' } })
  expect(f.sent).toHaveLength(2)
})

test('stop drains a pending async activity lookup without publishing its late result', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'push-async-stop-'))
  const sent: PushDelivery[] = []
  let resolve!: (value: MobileActivity[]) => void
  const service = new MobilePushService({ directory, transport: { configured: () => true, send: async delivery => { sent.push(delivery); return 'sent' } }, activities: () => new Promise(done => { resolve = done }), summary: async () => null })
  try {
    service.register(input(), {})
    const pending = service.tick()
    const stopped = service.stop()
    resolve([{ id: 's', activityState: 'waiting', requestId: 'stale-request' }])
    await Promise.all([pending, stopped])
    expect(sent).toEqual([])
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }) }
})

test('completion is rechecked against the async durable snapshot before delivery', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'push-completion-race-'))
  const sent: PushDelivery[] = []
  let current: MobileActivity[] = [{ id: 's', activityState: 'running' }]
  const service = new MobilePushService({ directory, transport: { configured: () => true, send: async delivery => { sent.push(delivery); return 'sent' } }, activities: async () => current, summary: async () => {
    current = [{ id: 's', activityState: 'idle', terminalOutcome: 'stopped' }]
    return null
  } })
  try {
    service.register(input(), {})
    await service.tick()
    current = [completed()]
    await service.tick()
    expect(sent).toEqual([])
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }) }
})

test('Live Activity initial update retries and heartbeats extend its truthful freshness', async () => {
  const f = fixture()
  let attempts = 0
  f.transport.send = async delivery => { attempts++; if (attempts === 1) throw new Error('offline'); f.sent.push(delivery); return 'sent' }
  f.service.register(input({ kind: 'liveActivity', deviceToken: 'b'.repeat(64), sessionId: 's', activityId: 'activity', name: 'CCHahaTaskActivity' }), {})
  f.state([{ id: 's', activityState: 'running' }]); await f.service.tick()
  f.advance(5000); await f.service.tick()
  expect(f.sent).toHaveLength(1)
  f.advance(59000); await f.service.tick()
  expect(f.sent).toHaveLength(1)
  f.advance(1000); await f.service.tick()
  expect(f.sent).toHaveLength(2)
  expect((f.sent[1]!.payload.aps as Record<string, number>)['stale-date']).toBeGreaterThan((f.sent[0]!.payload.aps as Record<string, number>)['stale-date']!)
})

test('Live Activity counts waiting work and never restores expired or preference-blocked quick actions', async () => {
  for (const reason of ['enabled', 'preferences', 'quiet', 'expired'] as const) {
    const f = fixture()
    f.service.register(input({ kind: 'liveActivity', deviceToken: 'b'.repeat(64), sessionId: 's', activityId: 'a', name: 'CCHahaTaskActivity',
      ...(reason === 'preferences' ? { preferences: { decisions: false, errors: true, completed: true } } : {}),
      ...(reason === 'quiet' ? { quietHours: { enabled: true, start: '00:00', end: '23:59' } } : {}),
    }), {})
    f.state([{ id: 's', activityState: 'waiting', requestId: 'permission', toolName: 'Bash', ...(reason === 'expired' ? { autoAnswerDeadline: 1 } : {}) }])
    await f.service.tick()
    const content = (f.sent[0]!.payload.aps as Record<string, unknown>)['content-state'] as { props: string }
    const props = JSON.parse(content.props)
    expect(props.activeCount).toBe(1)
    expect(typeof props.allowUrl === 'string').toBe(reason === 'enabled')
    expect(typeof props.denyUrl === 'string').toBe(reason === 'enabled')
  }
})
