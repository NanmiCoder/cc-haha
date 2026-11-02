import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { PushTransport, MobilePushPlatform, MobilePushProvider, PushDelivery, PulledNotification } from './mobilePushTransport.js'
import type { MobileSessionActivity } from './mobileSessionActivity.js'

export type MobileActivity = MobileSessionActivity
export type PushDeliveryOptions = { channels?: 'split'; timeSensitive?: boolean; liveActivity?: 'running' | 'decisions'; showCommand?: boolean }
export type PushInput = { platform: MobilePushPlatform; provider?: MobilePushProvider; token: string; deviceToken?: string; hostId: string; hostName?: string; kind?: 'notification' | 'liveActivity'; sessionId?: string; activityId?: string; name?: string; preferences: { decisions: boolean; completed: boolean; errors: boolean }; delivery?: PushDeliveryOptions; quietHours: { enabled: boolean; start: string; end: string }; timeZone: string }
export type PushOwner = { remoteDeviceId?: string; remoteDeviceExpiresAt?: number }
type Registration = Omit<PushInput, 'token' | 'deviceToken'> & { id: string; kind: 'notification' | 'liveActivity'; tokenHash: string; parentDeviceTokenHash: string; encryptedToken: string; owner: string; expiresAt: number }
/** `pull`: phones that pull from this computer; `relay`: Expo and this computer's own APNs / FCM. */
type Lane = 'pull' | 'relay'
type Stored = Record<string, unknown> & { version: 1; registrations: Registration[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeString = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)
const inputKeys = ['platform', 'provider', 'hostId', 'hostName', 'kind', 'sessionId', 'activityId', 'name', 'preferences', 'delivery', 'quietHours', 'timeZone']
// Expo's own check is prefix + closing bracket; whitespace and controls never belong in a header-free JSON token.
const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[^\s\]\u0000-\u001f]{1,256}\]$/
// The phone's own random secret for pulling from this computer (32 bytes, base64url).
const DESKTOP_TOKEN = /^[A-Za-z0-9_-]{43,128}$/
const validToken = (platform: unknown, provider: unknown, token: unknown) => typeof token === 'string' && (
  provider === 'expo' ? EXPO_TOKEN.test(token)
    : provider === 'desktop' ? platform === 'android' && DESKTOP_TOKEN.test(token)
      : provider === undefined && (platform === 'ios' ? /^[a-fA-F0-9]{64,512}$/ : /^[A-Za-z0-9_:\-]{32,4096}$/).test(token))
const fixtureToken = (platform: MobilePushPlatform, provider: unknown) => provider === 'expo' ? 'ExponentPushToken[fixture]' : provider === 'desktop' ? 'f'.repeat(43) : platform === 'ios' ? 'a'.repeat(64) : 'f'.repeat(64)
const deliveryKeys = ['channels', 'timeSensitive', 'liveActivity', 'showCommand']
const validDelivery = (value: unknown) => record(value) && Object.keys(value).every(key => deliveryKeys.includes(key)) &&
  (value.channels === undefined || value.channels === 'split') && (value.timeSensitive === undefined || typeof value.timeSensitive === 'boolean') &&
  (value.liveActivity === undefined || value.liveActivity === 'running' || value.liveActivity === 'decisions') && (value.showCommand === undefined || typeof value.showCommand === 'boolean')
const androidChannel = (delivery: PushDeliveryOptions | undefined, event: 'decision' | 'completed' | 'error') => delivery?.channels === 'split' ? event === 'decision' ? 'cc-haha-decisions' : event === 'completed' ? 'cc-haha-completed' : 'cc-haha-errors' : 'cc-haha'
const time = (value: unknown) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
type Alert = { title: string; body: string; category: 'cchahaTool' | 'cchahaDecision' | 'cchahaResult'; channel: string; timeSensitive: boolean; data: Record<string, string> }
/** One alert, in the wire format of the registration's provider. */
function alertPayload(row: Pick<Registration, 'platform' | 'provider'>, alert: Alert): Record<string, unknown> {
  const { title, category, channel, data } = alert
  // Expo and APNs both cap the whole payload at 4 KB.
  const body = alert.body.slice(0, 1000)
  if (row.provider === 'expo') return { title, body, data, categoryId: category, sound: 'default', priority: 'high', ttl: 300, ...(row.platform === 'ios' ? alert.timeSensitive ? { interruptionLevel: 'time-sensitive' } : {} : { channelId: channel }) }
  if (row.provider === 'desktop') return { title, body, data, category, channelId: channel }
  if (row.platform === 'ios') return { aps: { alert: { title, body }, sound: 'default', category, ...(alert.timeSensitive ? { 'interruption-level': 'time-sensitive' } : {}) }, ...data }
  return { notification: { title, body }, data, android: { priority: 'high', notification: { channel_id: channel } } }
}

export function validatePushInput(value: unknown): value is PushInput {
  if (!record(value) || Object.keys(value).some(key => !['platform', 'provider', 'token', 'deviceToken', 'hostId', 'hostName', 'kind', 'sessionId', 'activityId', 'name', 'preferences', 'delivery', 'quietHours', 'timeZone'].includes(key))) return false
  if (value.platform !== 'ios' && value.platform !== 'android') return false
  if (value.provider !== undefined && value.provider !== 'expo' && value.provider !== 'desktop') return false
  if (!validToken(value.platform, value.provider, value.token)) return false
  if (value.deviceToken !== undefined && (typeof value.deviceToken !== 'string' || !/^[a-fA-F0-9]{64,512}$/.test(value.deviceToken))) return false
  if (!safeString(value.hostId, 128) || value.hostName !== undefined && !safeString(value.hostName, 128)) return false
  if (value.kind !== undefined && value.kind !== 'notification' && value.kind !== 'liveActivity') return false
  // ActivityKit tokens only work with this computer's own APNs signature.
  if (value.kind === 'liveActivity' && (value.platform !== 'ios' || value.provider !== undefined || value.name !== 'CCHahaTaskActivity' || typeof value.deviceToken !== 'string' || !safeString(value.sessionId, 128) || !safeString(value.activityId, 256))) return false
  if (!record(value.preferences) || Object.keys(value.preferences).length !== 3 || !['decisions', 'completed', 'errors'].every(key => typeof value.preferences![key] === 'boolean')) return false
  if (value.delivery !== undefined && !validDelivery(value.delivery)) return false
  if (!record(value.quietHours) || Object.keys(value.quietHours).length !== 3 || typeof value.quietHours.enabled !== 'boolean' || !time(value.quietHours.start) || !time(value.quietHours.end)) return false
  if (!safeString(value.timeZone, 80)) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone as string }).format() } catch { return false }
  return true
}

/** Empty v0 installs had no registrations; unknown extensions survive future writes. */
export function migrateMobilePushStore(value: unknown): Stored {
  const previous = record(value) ? value : {}
  if (typeof previous.version === 'number' && previous.version > 1) throw new Error('Unsupported mobile push store version')
  const registrations = previous.version === 1 && Array.isArray(previous.registrations) ? previous.registrations.filter((row): row is Registration => record(row) && safeString(row.id, 128) && safeString(row.owner, 256) && typeof row.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(row.tokenHash) && typeof row.encryptedToken === 'string' && Number.isFinite(row.expiresAt) && validatePushInput({ ...Object.fromEntries(Object.entries(row).filter(([key]) => inputKeys.includes(key))), token: fixtureToken(row.platform, row.provider), ...(row.kind === 'liveActivity' ? { deviceToken: 'a'.repeat(64) } : {}) })) : []
  return { ...previous, version: 1, registrations: registrations.map(row => ({ ...row, parentDeviceTokenHash: typeof row.parentDeviceTokenHash === 'string' && /^[a-f0-9]{64}$/.test(row.parentDeviceTokenHash) ? row.parentDeviceTokenHash : row.tokenHash })) }
}
export function inQuietHours(input: Pick<PushInput, 'quietHours' | 'timeZone'>, now: number) {
  if (!input.quietHours.enabled) return false
  const current = new Intl.DateTimeFormat('en-GB', { timeZone: input.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now))
  const { start, end } = input.quietHours
  return start === end || (start < end ? current >= start && current < end : current >= start || current < end)
}
function hasSuccessfulCompletion(activity: MobileActivity) {
  return (activity.activityState === 'idle' || activity.activityState === 'review') &&
    activity.terminalOutcome === 'completed' && typeof activity.completedAt === 'number' &&
    Number.isFinite(activity.completedAt) && activity.completedAt > 0
}
export function pushEvent(previous: MobileActivity | undefined, current: MobileActivity): 'decision' | 'completed' | 'error' | undefined {
  if (current.activityState === 'waiting' && (!previous || previous.activityState !== 'waiting' || previous.requestId !== current.requestId)) return 'decision'
  if (current.activityState === 'running' && current.stalled && !previous?.stalled) return 'error'
  if (current.activityState === 'failed' && previous && previous.activityState !== 'failed') return 'error'
  if (previous && hasSuccessfulCompletion(current) &&
    (!hasSuccessfulCompletion(previous) || previous.completedAt !== current.completedAt)) return 'completed'
  return undefined
}

export class MobilePushService {
  private stored?: Stored
  private key?: Buffer
  private previous = new Map<string, Map<string, MobileActivity>>()
  private liveDeliveredAt = new Map<string, number>()
  private retries = new Map<string, { signature: string; event: 'decision' | 'completed' | 'error' | 'activity'; attempts: number; nextAt: number; activity: MobileActivity }>()
  private timer?: ReturnType<typeof setInterval>
  /** One in-flight pass per lane; see `tick`. */
  private lanes: Record<Lane, { ticking: boolean; done?: Promise<void>; finish?: () => void }> = { pull: { ticking: false }, relay: { ticking: false } }
  private generation = 0
  private remoteActive: (id: string) => boolean = () => false
  private remotePaired: (id: string) => boolean = () => false
  private lastError?: string
  /** The latest Expo send failed; the phones relying on it are told, cleared by the next success. */
  private expoError?: string
  private readonly file: string
  constructor(private deps: { transport: PushTransport; pull?: (token: string, ack: string | undefined, signal: AbortSignal) => Promise<PulledNotification[]>; activities(): MobileActivity[] | Promise<MobileActivity[]>; summary(id: string): Promise<{ title?: string } | null>; directory?: string; now?: () => number }) {
    this.file = path.join(deps.directory ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha'), 'mobile-push.json')
  }
  private signature(activity: MobileActivity) { return `${activity.activityState}:${activity.requestId ?? ''}:${Boolean(activity.stalled)}:${activity.terminalOutcome ?? ''}:${activity.completedAt ?? ''}` }
  private now() { return this.deps.now?.() ?? Date.now() }
  /**
   * `platforms`: this computer signs APNs / FCM itself. `providers`: relays that need
   * no local credentials. `relayErrors.expo`: why the last Expo send failed, if it did.
   */
  status() {
    const platforms = { ios: this.deps.transport.configured('ios'), android: this.deps.transport.configured('android') }
    const providers = { expo: this.deps.transport.configured('ios', 'expo'), desktop: !!this.deps.pull && this.deps.transport.configured('android', 'desktop') }
    return { platforms, providers, status: platforms.ios || platforms.android || providers.expo || providers.desktop ? 'configured' : 'notConfigured', ...(this.lastError ? { error: this.lastError } : {}), ...(this.expoError ? { relayErrors: { expo: this.expoError } } : {}) }
  }
  private recordExpo(row: Pick<Registration, 'provider'>, error?: unknown) {
    if (row.provider !== 'expo') return
    if (error === undefined) { this.expoError = undefined; return }
    const detail = error instanceof Error ? /^Expo push rejected delivery \((.+)\)$/.exec(error.message)?.[1] : undefined
    this.expoError = detail ? `Expo 推送服务拒绝了发送（${detail}）` : '电脑连不上 Expo 推送服务（exp.host）'
  }
  private configured(row: Pick<PushInput, 'platform' | 'provider'>) { return row.provider === 'desktop' ? !!this.deps.pull && this.deps.transport.configured(row.platform, 'desktop') : this.deps.transport.configured(row.platform, row.provider) }
  private load() {
    if (this.stored) return
    let stored: unknown = {}
    try { stored = JSON.parse(readFileSync(this.file, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Mobile push store is unavailable') }
    this.stored = migrateMobilePushStore(stored)
  }
  private encryptionKey() {
    if (this.key) return this.key
    const keyFile = `${this.file}.key`
    try { this.key = readFileSync(keyFile) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (this.stored?.registrations.length) throw new Error('Mobile push encryption key is missing; re-register devices')
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      this.key = randomBytes(32); writeFileSync(keyFile, this.key, { mode: 0o600, flag: 'wx' })
    }
    if (this.key.length !== 32) throw new Error('Invalid mobile push encryption key')
    return this.key
  }
  private encrypt(token: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv); const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64') }
  private decrypt(value: string) { const bytes = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8') }
  private persist() { mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`; writeFileSync(temporary, JSON.stringify(this.stored), { mode: 0o600 }); renameSync(temporary, this.file) }
  private owner(input: PushInput, context: PushOwner) { return context.remoteDeviceId ? `remote:${context.remoteDeviceId}` : `lan:${hash(input.deviceToken ?? input.token)}` }
  register(input: PushInput, context: PushOwner) {
    if (!this.configured(input)) return { registered: false, status: 'notConfigured' as const }
    this.load()
    const owner = this.owner(input, context), kind = input.kind ?? 'notification'
    const tokenHash = hash(input.token), id = hash(`${owner}:${kind}:${tokenHash}`)
    const expiresAt = Math.min(this.now() + (kind === 'liveActivity' ? 8 * 3600000 : 30 * 86400000), context.remoteDeviceExpiresAt ?? Infinity)
    const { token, deviceToken, ...rest } = input
    const { delivery: _previousDelivery, ...existing } = this.stored!.registrations.find(row => row.id === id) ?? {} as Partial<Registration>
    const registration: Registration = { ...existing, ...rest, kind, id, owner, tokenHash, parentDeviceTokenHash: hash(deviceToken ?? token), encryptedToken: this.encrypt(token), expiresAt }
    const remaining = this.stored!.registrations.filter(row => row.id !== id && !(row.owner === owner && row.kind === kind && (kind === 'notification' ? row.platform === input.platform : row.activityId === input.activityId)))
    if (remaining.length >= 64) throw new Error('Mobile push device limit reached')
    this.stored!.registrations = [...remaining, registration]; this.persist()
    return { registered: true, status: 'registered' as const, id, expiresAt }
  }
  unregister(id: string, token: string, context: PushOwner) {
    this.load()
    const found = this.stored!.registrations.find(row => row.id === id)
    const sameOwner = context.remoteDeviceId ? found?.owner === `remote:${context.remoteDeviceId}` : found?.owner.startsWith('lan:')
    // A LAN Live Activity has its parent device's owner hash. Its own opaque
    // activity token still proves single-registration ownership when it ends.
    if (!found || !sameOwner || found.tokenHash !== hash(token)) return false
    this.stored!.registrations = this.stored!.registrations.filter(row => row !== found); this.previous.delete(id); this.persist(); return true
  }
  unregisterDevice(token: string, hostId: string, context: PushOwner) {
    this.load()
    const tokenHash = hash(token)
    const owner = context.remoteDeviceId ? `remote:${context.remoteDeviceId}` : `lan:${tokenHash}`
    const removed = this.stored!.registrations.filter(row => row.owner === owner && row.hostId === hostId && row.parentDeviceTokenHash === tokenHash)
    if (removed.length) {
      this.stored!.registrations = this.stored!.registrations.filter(row => !removed.includes(row))
      for (const row of removed) this.previous.delete(row.id)
      this.persist()
    }
    return removed.length
  }
  /** Explicit test from the phone: bypasses preferences and quiet hours, never reveals tokens. */
  async sendTest(token: string, hostId: string | undefined, context: PushOwner): Promise<{ status: 'sent' | 'notConfigured' | 'noRegistration' | 'failed'; error?: string }> {
    this.load()
    const tokenHash = hash(token)
    const owner = context.remoteDeviceId ? `remote:${context.remoteDeviceId}` : `lan:${tokenHash}`
    const rows = this.stored!.registrations.filter(row => row.kind === 'notification' && row.owner === owner && row.tokenHash === tokenHash && (hostId === undefined || row.hostId === hostId) && row.expiresAt > this.now())
    // Phones that predate relays only register direct tokens: without this computer's
    // own keys they could never have registered, so "not configured" is their truth.
    if (!rows.length) {
      const { platforms } = this.status()
      return { status: platforms.ios || platforms.android ? 'noRegistration' : 'notConfigured' }
    }
    const configured = rows.filter(row => this.configured(row))
    if (!configured.length) return { status: 'notConfigured' }
    let failed = false
    for (const row of configured) {
      const payload = alertPayload(row, { title: '测试通知 · cc-haha', body: '电脑推送正常：这条是电脑发给你手机的。', category: 'cchahaResult', channel: androidChannel(row.delivery, 'completed'), timeSensitive: false, data: { hostId: row.hostId, eventType: 'test' } })
      try {
        const result = await this.deps.transport.send({ platform: row.platform, kind: 'notification', ...(row.provider ? { provider: row.provider } : {}), token: this.decrypt(row.encryptedToken), payload } satisfies PushDelivery)
        this.recordExpo(row)
        if (result === 'invalidToken') { this.stored!.registrations = this.stored!.registrations.filter(item => item !== row); this.previous.delete(row.id); this.persist(); failed = true }
      } catch (error) { this.recordExpo(row, error); failed = true }
    }
    return failed ? { status: 'failed', error: '系统推送投递失败，请检查电脑的 APNs / FCM 配置与网络。' } : { status: 'sent' }
  }
  /** The phone's long poll for `desktop` registrations; `undefined` when the caller owns none. */
  async pull(token: string, ack: string | undefined, context: PushOwner, signal: AbortSignal): Promise<PulledNotification[] | undefined> {
    if (!this.deps.pull) return undefined
    this.load()
    const tokenHash = hash(token)
    const owner = context.remoteDeviceId ? `remote:${context.remoteDeviceId}` : `lan:${tokenHash}`
    const registered = this.stored!.registrations.some(row => row.kind === 'notification' && row.provider === 'desktop' && row.owner === owner && row.tokenHash === tokenHash && this.active(row))
    return registered ? this.deps.pull(token, ack, signal) : undefined
  }
  /**
   * `remoteActive`: the remote listener accepts this device now, so it may be
   * delivered to. `remotePaired`: the pairing still exists; only its loss (revoked
   * or expired) deletes the registration. A tunnel restart stops the listener for
   * a moment and must not make every remote phone register again.
   */
  start(remoteActive: (id: string) => boolean, remotePaired: (id: string) => boolean = remoteActive) {
    this.remoteActive = remoteActive
    this.remotePaired = remotePaired
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, 5000)
    this.timer.unref?.()
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.generation++; this.previous.clear(); this.retries.clear(); this.liveDeliveredAt.clear(); await Promise.all([this.lanes.pull.done, this.lanes.relay.done]) }
  private active(row: Registration) { return row.expiresAt > this.now() && (!row.owner.startsWith('remote:') || this.remoteActive(row.owner.slice(7))) }
  private retained(row: Registration) { return row.expiresAt > this.now() && (!row.owner.startsWith('remote:') || this.remotePaired(row.owner.slice(7))) }
  /**
   * Pulled alerts only enqueue; relays (Expo, APNs, FCM) wait on the network, up
   * to 15 s per attempt when it is unreachable. Each lane skips a tick while its
   * own previous pass is still running, so a stalled relay never holds back the
   * phones that pull.
   */
  async tick() {
    const lanes = (['pull', 'relay'] as const).filter(lane => !this.lanes[lane].ticking)
    if (!lanes.length) return
    for (const lane of lanes) {
      const state = this.lanes[lane]
      state.ticking = true
      state.done = new Promise(resolve => { state.finish = resolve })
    }
    // One activity read per tick, shared by the lanes that start now; issued
    // synchronously so a caller may settle it right after calling tick().
    const snapshot = (async () => this.deps.activities())()
    await Promise.all(lanes.map(lane => this.tickLane(lane, snapshot)))
  }
  private async tickLane(lane: Lane, snapshot: Promise<MobileActivity[]>) {
    const state = this.lanes[lane]
    const generation = this.generation
    try {
      this.load()
      const before = this.stored!.registrations.length
      this.stored!.registrations = this.stored!.registrations.filter(row => this.retained(row))
      if (before !== this.stored!.registrations.length) this.persist()
      const current = await snapshot
      if (generation !== this.generation) return
      const registeredIds = new Set(this.stored!.registrations.map(row => row.id))
      for (const id of this.previous.keys()) if (!registeredIds.has(id)) this.previous.delete(id)
      for (const id of this.liveDeliveredAt.keys()) if (!registeredIds.has(id)) this.liveDeliveredAt.delete(id)
      for (const key of this.retries.keys()) if (!registeredIds.has(key.split(':')[0]!)) this.retries.delete(key)
      for (const registration of this.stored!.registrations.filter(row => (row.provider === 'desktop') === (lane === 'pull'))) {
        // A remote phone whose listener is down keeps its registration and catches up when it returns.
        if (!this.configured(registration) || !this.active(registration)) continue
        const prior = this.previous.get(registration.id) ?? new Map<string, MobileActivity>()
        this.previous.set(registration.id, prior)
        const observed = new Map(current.map(item => [item.id, item]))
        // Disappearance may close a Live Activity, but it is never evidence of
        // success and must not retain a previous completion retry.
        for (const id of prior.keys()) if (!observed.has(id)) observed.set(id, { id, activityState: 'idle' })
        if (registration.kind === 'liveActivity' && registration.sessionId && !observed.has(registration.sessionId)) {
          observed.set(registration.sessionId, { id: registration.sessionId, activityState: 'idle' })
        }
        for (const activity of observed.values()) {
          if (registration.kind === 'liveActivity' && registration.sessionId !== activity.id) continue
          const previous = prior.get(activity.id)
          prior.set(activity.id, activity)
          const retryKey = `${registration.id}:${activity.id}`
          const signature = this.signature(activity)
          let retry = this.retries.get(retryKey)
          if (retry && retry.signature !== signature) { this.retries.delete(retryKey); retry = undefined }
          const event = pushEvent(previous, activity) ?? retry?.event
          if (retry && (retry.attempts >= 3 || retry.nextAt > this.now())) continue
          const changed = !previous || this.signature(previous) !== signature
          if (registration.kind === 'notification' && (!event || !registration.preferences[event === 'decision' ? 'decisions' : event === 'completed' ? 'completed' : 'errors'] || inQuietHours(registration, this.now()))) continue
          if (registration.kind === 'liveActivity' && !changed && !retry && this.now() - (this.liveDeliveredAt.get(registration.id) ?? 0) < 60000) continue
          const summary = await this.deps.summary(activity.id)
          if (generation !== this.generation) return
          const latest = (await this.deps.activities()).find(row => row.id === activity.id)
          if (generation !== this.generation) return
          if (latest ? this.signature(latest) !== signature : activity.activityState !== 'idle' || hasSuccessfulCompletion(activity)) { this.retries.delete(retryKey); continue }
          if (!this.active(registration) || !this.stored!.registrations.includes(registration)) continue
          const title = summary?.title?.slice(0, 100) || 'cc-haha 会话'
          const data = { hostId: registration.hostId, sessionId: activity.id, ...(activity.requestId ? { requestId: activity.requestId } : {}), eventType: event ?? activity.activityState }
          const tool = activity.activityState === 'waiting' && activity.requestId && activity.toolName && registration.preferences.decisions && !inQuietHours(registration, this.now()) && !(typeof activity.autoAnswerDeadline === 'number' && activity.autoAnswerDeadline <= this.now()) && !['AskUserQuestion', 'ExitPlanMode', 'ComputerUse'].includes(activity.toolName)
          // 隐私开关也管锁屏上的普通通知：只有 Bash 的 preview 是命令原文，其他工具的 preview 本来就是通用占位。
          const hideCommand = registration.delivery?.showCommand === false && activity.toolName === 'Bash'
          const body = event === 'decision' ? hideCommand ? '打开 App 查看命令' : activity.preview || '需要你做决定' : event === 'error' ? activity.stalled ? '超过 5 分钟没有进展，请打开查看' : '任务遇到错误，请打开查看' : '任务已完成'
          let payload: Record<string, unknown>
          if (registration.kind === 'liveActivity') {
            const base = `cchaha:///chat/${encodeURIComponent(activity.id)}?host=${encodeURIComponent(registration.hostId)}`
            const request = activity.requestId ? `&requestId=${encodeURIComponent(activity.requestId)}` : ''
            const terminal = activity.activityState === 'idle' || activity.activityState === 'review' || activity.activityState === 'failed'
            // 'decisions' mode keeps remote pushes from reviving a running-only activity: end it instead.
            const decisionsOnly = registration.delivery?.liveActivity === 'decisions' && activity.activityState === 'running'
            const ended = terminal || decisionsOnly
            const completed = hasSuccessfulCompletion(activity)
            const unknownEnd = terminal && !completed && activity.activityState !== 'failed'
            const timestamp = Math.floor(this.now() / 1000)
            const detail = registration.delivery?.showCommand === false
              ? activity.activityState === 'waiting' ? activity.toolName === 'Bash' ? '打开 App 查看命令' : '需要你做决定' : activity.activityState === 'running' ? '' : '本次运行已结束'
              : activity.preview ?? (activity.activityState === 'running' ? '正在运行' : '本次运行已结束')
            payload = { aps: { timestamp, event: ended ? 'end' : 'update', 'stale-date': unknownEnd ? timestamp - 1 : timestamp + 90, ...(ended ? { 'dismissal-date': timestamp + (unknownEnd || decisionsOnly ? 0 : 60) } : {}), 'content-state': { name: 'CCHahaTaskActivity', props: JSON.stringify({ hostId: registration.hostId, hostName: registration.hostName ?? '电脑', sessionId: activity.id, title, detail: detail, status: completed ? 'completed' : unknownEnd ? 'running' : activity.activityState, ...(unknownEnd ? { connectionState: 'stale' } : {}), activeCount: current.filter(row => row.activityState === 'running' || row.activityState === 'waiting').length, requestId: activity.requestId, openUrl: base + request, ...(tool ? { allowUrl: `${base}${request}&notificationAction=allow`, denyUrl: `${base}${request}&notificationAction=deny` } : {}) }) } } }
          } else payload = alertPayload(registration, { title, body, category: tool ? 'cchahaTool' : event === 'decision' ? 'cchahaDecision' : 'cchahaResult', channel: androidChannel(registration.delivery, event === 'decision' || event === 'completed' || event === 'error' ? event : 'completed'), timeSensitive: event === 'decision' && registration.delivery?.timeSensitive === true, data })
          try {
            const result = await this.deps.transport.send({ platform: registration.platform, kind: registration.kind, ...(registration.provider ? { provider: registration.provider } : {}), token: this.decrypt(registration.encryptedToken), payload } satisfies PushDelivery)
            if (generation !== this.generation) return
            this.retries.delete(retryKey)
            if (registration.kind === 'liveActivity') this.liveDeliveredAt.set(registration.id, this.now())
            this.lastError = undefined
            this.recordExpo(registration)
            if (result === 'invalidToken' || registration.kind === 'liveActivity' && (['idle', 'review', 'failed'].includes(activity.activityState) || registration.delivery?.liveActivity === 'decisions' && activity.activityState === 'running')) { this.stored!.registrations = this.stored!.registrations.filter(row => row !== registration); this.previous.delete(registration.id); this.persist(); break }
          } catch (error) {
            this.retries.set(retryKey, { signature, event: event ?? 'activity', activity, attempts: (retry?.attempts ?? 0) + 1, nextAt: this.now() + 5000 * 2 ** (retry?.attempts ?? 0) })
            this.lastError = '系统推送投递失败，请检查电脑的 APNs / FCM 配置与网络。'
            if (generation === this.generation) this.recordExpo(registration, error)
          }
        }
      }
    } catch { this.lastError = '系统推送存储不可用，请检查电脑上的推送配置。' }
    finally { state.ticking = false; state.finish?.(); state.finish = undefined; state.done = undefined }
  }
}
