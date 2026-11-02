import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { PushTransport, MobilePushPlatform, PushDelivery } from './mobilePushTransport.js'
import type { MobileSessionActivity } from './mobileSessionActivity.js'

export type MobileActivity = MobileSessionActivity
export type PushDeliveryOptions = { channels?: 'split'; timeSensitive?: boolean; liveActivity?: 'running' | 'decisions'; showCommand?: boolean }
export type PushInput = { platform: MobilePushPlatform; token: string; deviceToken?: string; hostId: string; hostName?: string; kind?: 'notification' | 'liveActivity'; sessionId?: string; activityId?: string; name?: string; preferences: { decisions: boolean; completed: boolean; errors: boolean }; delivery?: PushDeliveryOptions; quietHours: { enabled: boolean; start: string; end: string }; timeZone: string }
export type PushOwner = { remoteDeviceId?: string; remoteDeviceExpiresAt?: number }
type Registration = Omit<PushInput, 'token' | 'deviceToken'> & { id: string; kind: 'notification' | 'liveActivity'; tokenHash: string; parentDeviceTokenHash: string; encryptedToken: string; owner: string; expiresAt: number }
type Stored = Record<string, unknown> & { version: 1; registrations: Registration[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeString = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)
const inputKeys = ['platform', 'hostId', 'hostName', 'kind', 'sessionId', 'activityId', 'name', 'preferences', 'delivery', 'quietHours', 'timeZone']
const deliveryKeys = ['channels', 'timeSensitive', 'liveActivity', 'showCommand']
const validDelivery = (value: unknown) => record(value) && Object.keys(value).every(key => deliveryKeys.includes(key)) &&
  (value.channels === undefined || value.channels === 'split') && (value.timeSensitive === undefined || typeof value.timeSensitive === 'boolean') &&
  (value.liveActivity === undefined || value.liveActivity === 'running' || value.liveActivity === 'decisions') && (value.showCommand === undefined || typeof value.showCommand === 'boolean')
const androidChannel = (delivery: PushDeliveryOptions | undefined, event: 'decision' | 'completed' | 'error') => delivery?.channels === 'split' ? event === 'decision' ? 'cc-haha-decisions' : event === 'completed' ? 'cc-haha-completed' : 'cc-haha-errors' : 'cc-haha'
const time = (value: unknown) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)

export function validatePushInput(value: unknown): value is PushInput {
  if (!record(value) || Object.keys(value).some(key => !['platform', 'token', 'deviceToken', 'hostId', 'hostName', 'kind', 'sessionId', 'activityId', 'name', 'preferences', 'delivery', 'quietHours', 'timeZone'].includes(key))) return false
  if (value.platform !== 'ios' && value.platform !== 'android') return false
  if (typeof value.token !== 'string' || !(value.platform === 'ios' ? /^[a-fA-F0-9]{64,512}$/ : /^[A-Za-z0-9_:\-]{32,4096}$/).test(value.token)) return false
  if (value.deviceToken !== undefined && (typeof value.deviceToken !== 'string' || !/^[a-fA-F0-9]{64,512}$/.test(value.deviceToken))) return false
  if (!safeString(value.hostId, 128) || value.hostName !== undefined && !safeString(value.hostName, 128)) return false
  if (value.kind !== undefined && value.kind !== 'notification' && value.kind !== 'liveActivity') return false
  if (value.kind === 'liveActivity' && (value.platform !== 'ios' || value.name !== 'CCHahaTaskActivity' || typeof value.deviceToken !== 'string' || !safeString(value.sessionId, 128) || !safeString(value.activityId, 256))) return false
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
  const registrations = previous.version === 1 && Array.isArray(previous.registrations) ? previous.registrations.filter((row): row is Registration => record(row) && safeString(row.id, 128) && safeString(row.owner, 256) && typeof row.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(row.tokenHash) && typeof row.encryptedToken === 'string' && Number.isFinite(row.expiresAt) && validatePushInput({ ...Object.fromEntries(Object.entries(row).filter(([key]) => inputKeys.includes(key))), token: row.platform === 'ios' ? 'a'.repeat(64) : 'f'.repeat(64), ...(row.kind === 'liveActivity' ? { deviceToken: 'a'.repeat(64) } : {}) })) : []
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
  private ticking = false
  private generation = 0
  private tickDone?: Promise<void>
  private finishTick?: () => void
  private remoteActive: (id: string) => boolean = () => false
  private lastError?: string
  private readonly file: string
  constructor(private deps: { transport: PushTransport; activities(): MobileActivity[] | Promise<MobileActivity[]>; summary(id: string): Promise<{ title?: string } | null>; directory?: string; now?: () => number }) {
    this.file = path.join(deps.directory ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha'), 'mobile-push.json')
  }
  private signature(activity: MobileActivity) { return `${activity.activityState}:${activity.requestId ?? ''}:${Boolean(activity.stalled)}:${activity.terminalOutcome ?? ''}:${activity.completedAt ?? ''}` }
  private now() { return this.deps.now?.() ?? Date.now() }
  status() { const platforms = { ios: this.deps.transport.configured('ios'), android: this.deps.transport.configured('android') }; return { platforms, status: platforms.ios || platforms.android ? 'configured' : 'notConfigured', ...(this.lastError ? { error: this.lastError } : {}) } }
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
    if (!this.deps.transport.configured(input.platform)) return { registered: false, status: 'notConfigured' as const }
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
    if (!rows.length) return { status: this.status().status === 'notConfigured' ? 'notConfigured' : 'noRegistration' }
    const configured = rows.filter(row => this.deps.transport.configured(row.platform))
    if (!configured.length) return { status: 'notConfigured' }
    let failed = false
    for (const row of configured) {
      const title = '测试通知 · cc-haha', body = '电脑推送正常：这条是电脑发给你手机的。'
      const data = { hostId: row.hostId, eventType: 'test' }
      const payload = row.platform === 'ios'
        ? { aps: { alert: { title, body }, sound: 'default', category: 'cchahaResult' }, ...data }
        : { notification: { title, body }, data, android: { priority: 'high', notification: { channel_id: androidChannel(row.delivery, 'completed') } } }
      try {
        const result = await this.deps.transport.send({ platform: row.platform, kind: 'notification', token: this.decrypt(row.encryptedToken), payload } satisfies PushDelivery)
        if (result === 'invalidToken') { this.stored!.registrations = this.stored!.registrations.filter(item => item !== row); this.previous.delete(row.id); this.persist(); failed = true }
      } catch { failed = true }
    }
    return failed ? { status: 'failed', error: '系统推送投递失败，请检查电脑的 APNs / FCM 配置与网络。' } : { status: 'sent' }
  }
  start(remoteActive: (id: string) => boolean) {
    this.remoteActive = remoteActive
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, 5000)
    this.timer.unref?.()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.generation++; this.previous.clear(); this.retries.clear(); this.liveDeliveredAt.clear(); return this.tickDone ?? Promise.resolve() }
  private active(row: Registration) { return row.expiresAt > this.now() && (!row.owner.startsWith('remote:') || this.remoteActive(row.owner.slice(7))) }
  async tick() {
    if (this.ticking) return
    this.ticking = true
    const generation = this.generation
    this.tickDone = new Promise(resolve => { this.finishTick = resolve })
    try {
      this.load()
      const before = this.stored!.registrations.length
      this.stored!.registrations = this.stored!.registrations.filter(row => this.active(row))
      if (before !== this.stored!.registrations.length) this.persist()
      const current = await this.deps.activities()
      if (generation !== this.generation) return
      const registeredIds = new Set(this.stored!.registrations.map(row => row.id))
      for (const id of this.previous.keys()) if (!registeredIds.has(id)) this.previous.delete(id)
      for (const id of this.liveDeliveredAt.keys()) if (!registeredIds.has(id)) this.liveDeliveredAt.delete(id)
      for (const key of this.retries.keys()) if (!registeredIds.has(key.split(':')[0]!)) this.retries.delete(key)
      for (const registration of [...this.stored!.registrations]) {
        if (!this.deps.transport.configured(registration.platform)) continue
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
          } else if (registration.platform === 'ios') payload = { aps: { alert: { title, body }, sound: 'default', category: tool ? 'cchahaTool' : event === 'decision' ? 'cchahaDecision' : 'cchahaResult', ...(event === 'decision' && registration.delivery?.timeSensitive === true ? { 'interruption-level': 'time-sensitive' } : {}) }, ...data }
          else payload = { notification: { title, body }, data, android: { priority: 'high', notification: { channel_id: androidChannel(registration.delivery, event === 'decision' || event === 'completed' || event === 'error' ? event : 'completed') } } }
          try {
            const result = await this.deps.transport.send({ platform: registration.platform, kind: registration.kind, token: this.decrypt(registration.encryptedToken), payload } satisfies PushDelivery)
            if (generation !== this.generation) return
            this.retries.delete(retryKey)
            if (registration.kind === 'liveActivity') this.liveDeliveredAt.set(registration.id, this.now())
            this.lastError = undefined
            if (result === 'invalidToken' || registration.kind === 'liveActivity' && (['idle', 'review', 'failed'].includes(activity.activityState) || registration.delivery?.liveActivity === 'decisions' && activity.activityState === 'running')) { this.stored!.registrations = this.stored!.registrations.filter(row => row !== registration); this.previous.delete(registration.id); this.persist(); break }
          } catch {
            this.retries.set(retryKey, { signature, event: event ?? 'activity', activity, attempts: (retry?.attempts ?? 0) + 1, nextAt: this.now() + 5000 * 2 ** (retry?.attempts ?? 0) })
            this.lastError = '系统推送投递失败，请检查电脑的 APNs / FCM 配置与网络。'
          }
        }
      }
    } catch { this.lastError = '系统推送存储不可用，请检查电脑上的推送配置。' }
    finally { this.ticking = false; this.finishTick?.(); this.finishTick = undefined; this.tickDone = undefined }
  }
}
