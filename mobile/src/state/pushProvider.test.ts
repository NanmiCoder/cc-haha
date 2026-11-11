import { expect, test } from 'bun:test'
import { PushTokens, base64url, choosePushProvider, pullTokenKey, relayFailure } from './pushProvider'

test('the computer decides the channel; Android pulls, iOS prefers the computer keys over Expo', () => {
  const both = { platforms: { ios: false, android: false }, providers: { expo: true, desktop: true } }
  expect(choosePushProvider('android', both)).toBe('desktop')
  expect(choosePushProvider('ios', both)).toBe('expo')
  // The publisher's own computer: APNs keys also carry Live Activities.
  expect(choosePushProvider('ios', { ...both, platforms: { ios: true, android: true } })).toBe('direct')
  // Pulling works on every Android phone; FCM needs Google services and a Firebase build.
  expect(choosePushProvider('android', { ...both, platforms: { ios: true, android: true } })).toBe('desktop')
  // Computers from before relay providers.
  expect(choosePushProvider('android', { platforms: { ios: false, android: true } })).toBe('direct')
  expect(choosePushProvider('ios', { platforms: { ios: false, android: false } })).toBeUndefined()
  expect(choosePushProvider('android', { platforms: { ios: true, android: false }, providers: { expo: true } })).toBeUndefined()
  expect(choosePushProvider('ios', { platforms: { ios: false, android: false }, providers: { expo: 'yes' } })).toBeUndefined()
})

test('base64url matches the standard encoding without padding', () => {
  for (const length of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 97 + 13) & 255)
    expect(base64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
  }
})

test('the pull token is created once per phone, persisted, and survives concurrent first use', async () => {
  const values = new Map<string, string>()
  let writes = 0
  const secrets = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { writes++; values.set(key, value) },
    removeItem: async (key: string) => { values.delete(key) },
  }
  let draws = 0
  const deps = {
    random: (count: number) => { draws++; return Uint8Array.from({ length: count }, (_, index) => (index + draws) & 255) },
    device: async () => 'native-token',
    expo: async () => 'ExponentPushToken[fixture]',
  }
  const tokens = new PushTokens(secrets, deps)
  const [first, second] = await Promise.all([tokens.token('desktop', 'home'), tokens.token('desktop', 'home')])
  expect(first).toBe(second!)
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(values.get(pullTokenKey('home'))).toBe(first)
  expect([draws, writes]).toEqual([1, 1])
  // A new process reads the stored secret instead of minting another one.
  expect(await new PushTokens(secrets, deps).token('desktop', 'home')).toBe(first)
  expect(draws).toBe(1)
  // Damaged storage is replaced, not trusted.
  values.set(pullTokenKey('home'), 'short')
  expect(await new PushTokens(secrets, deps).token('desktop', 'home')).not.toBe('short')
  expect(await tokens.token('direct', 'home')).toBe('native-token')
  expect(await tokens.token('expo', 'home')).toBe('ExponentPushToken[fixture]')
})

test('every computer gets its own pull secret, and removing it discards that secret', async () => {
  const values = new Map<string, string>()
  const secrets = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value) },
    removeItem: async (key: string) => { values.delete(key) },
  }
  let seed = 0
  const tokens = new PushTokens(secrets, { random: count => Uint8Array.from({ length: count }, () => ++seed & 255), device: async () => '', expo: async () => '' })
  const home = await tokens.token('desktop', 'home')
  const office = await tokens.token('desktop', 'office')
  // A computer learns only its own secret, so it cannot read the phone's alerts from another one.
  expect(home).not.toBe(office)
  await tokens.forget('home')
  expect(values.has(pullTokenKey('home'))).toBe(false)
  expect(await tokens.token('desktop', 'home')).not.toBe(home)
  expect(await tokens.token('desktop', 'office')).toBe(office)
})

test('a failed storage write is retried by the next request instead of being cached', async () => {
  let fail = true
  const values = new Map<string, string>()
  const tokens = new PushTokens({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { if (fail) throw new Error('SecureStore unavailable'); values.set(key, value) },
    removeItem: async () => {},
  }, { random: count => new Uint8Array(count).fill(7), device: async () => '', expo: async () => '' })
  await expect(tokens.token('desktop', 'home')).rejects.toThrow('SecureStore unavailable')
  fail = false
  expect(await tokens.token('desktop', 'home')).toBe(values.get(pullTokenKey('home'))!)
})

test('only a relay failure that concerns this phone becomes its problem', () => {
  const failing = { platforms: { ios: false, android: false }, providers: { expo: true, desktop: true }, relayErrors: { expo: '电脑连不上 Expo 推送服务（exp.host）' } }
  expect(relayFailure('expo', failing)).toBe('电脑连不上 Expo 推送服务（exp.host）')
  // Android pulls from the computer; an Expo outage does not touch it.
  expect(relayFailure('desktop', failing)).toBeUndefined()
  expect(relayFailure('direct', failing)).toBeUndefined()
  expect(relayFailure('expo', { platforms: { ios: false, android: false } })).toBeUndefined()
  expect(relayFailure('expo', { relayErrors: { expo: 42 } })).toBeUndefined()
  expect(relayFailure('expo', { relayErrors: { expo: 'x'.repeat(500) } })).toHaveLength(200)
})
