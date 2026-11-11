import { existsSync, readFileSync } from 'node:fs'
import { createHash, randomUUID, sign } from 'node:crypto'
import { connect, type ClientHttp2Session } from 'node:http2'
import { getNetworkProxyFetchOptions, loadNetworkSettings } from './networkSettings.js'

export type MobilePushPlatform = 'ios' | 'android'
/**
 * How a phone receives pushes. Absent: this computer signs APNs / FCM itself and
 * needs the publisher's credentials. `expo`: the Expo Push Service holds them, so
 * any computer can send. `desktop`: the phone keeps pulling from this computer.
 */
export type MobilePushProvider = 'expo' | 'desktop'
export type PushDelivery = { token: string; platform: MobilePushPlatform; kind: 'notification' | 'liveActivity'; provider?: MobilePushProvider; payload: Record<string, unknown> }
export type PushTransport = { configured(platform: MobilePushPlatform, provider?: MobilePushProvider): boolean; send(delivery: PushDelivery): Promise<'sent' | 'invalidToken'> }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** Only explicitly configured files are opened. No keychain or ambient ADC discovery. */
export class DirectMobilePushTransport implements PushTransport {
  constructor(private env: NodeJS.ProcessEnv = process.env, private io: { fetch?: (url: string, init: RequestInit) => Promise<Response>; connect?: (origin: string) => ClientHttp2Session } = {}) {}
  configured(platform: MobilePushPlatform) {
    if (platform === 'ios') return ['KEY_PATH', 'KEY_ID', 'TEAM_ID', 'TOPIC'].every(key => !!this.env[`CC_HAHA_APNS_${key}`]) && existsSync(this.env.CC_HAHA_APNS_KEY_PATH!)
    return !!this.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(this.env.GOOGLE_APPLICATION_CREDENTIALS)
  }
  async send(delivery: PushDelivery): Promise<'sent' | 'invalidToken'> {
    if (!this.configured(delivery.platform)) throw new Error('Push provider is not configured')
    return delivery.platform === 'ios' ? this.apns(delivery) : this.fcm(delivery)
  }
  private async apns(delivery: PushDelivery): Promise<'sent' | 'invalidToken'> {
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${encode({ alg: 'ES256', kid: this.env.CC_HAHA_APNS_KEY_ID })}.${encode({ iss: this.env.CC_HAHA_APNS_TEAM_ID, iat: now })}`
    const signature = sign('sha256', Buffer.from(unsigned), { key: readFileSync(this.env.CC_HAHA_APNS_KEY_PATH!, 'utf8'), dsaEncoding: 'ieee-p1363' }).toString('base64url')
    const origin = this.env.CC_HAHA_APNS_SANDBOX === 'true' || this.env.CC_HAHA_APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
    return new Promise((resolve, reject) => {
      const connection = (this.io.connect ?? connect)(origin)
      const timer = setTimeout(() => { connection.destroy(); reject(new Error('APNs delivery timed out')) }, 15000)
      let settled = false
      const finish = (error?: Error, result: 'sent' | 'invalidToken' = 'sent') => { if (settled) return; settled = true; clearTimeout(timer); connection.close(); error ? reject(error) : resolve(result) }
      connection.on('error', () => finish(new Error('APNs connection failed')))
      const request = connection.request({ ':method': 'POST', ':path': `/3/device/${delivery.token}`, authorization: `bearer ${unsigned}.${signature}`, 'apns-topic': `${this.env.CC_HAHA_APNS_TOPIC}${delivery.kind === 'liveActivity' ? '.push-type.liveactivity' : ''}`, 'apns-push-type': delivery.kind === 'liveActivity' ? 'liveactivity' : 'alert', 'apns-priority': '10', 'apns-expiration': String(now + 300) })
      let status = 0, body = ''
      request.on('response', headers => { status = Number(headers[':status']) })
      request.on('data', chunk => { if (body.length < 4096) body += chunk.toString() })
      request.on('error', () => finish(new Error('APNs delivery failed')))
      request.on('end', () => {
        if (status === 200) finish()
        else if (status === 410 || status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(body)) finish(undefined, 'invalidToken')
        else finish(new Error(`APNs rejected delivery (${status})`))
      })
      request.end(JSON.stringify(delivery.payload))
    })
  }
  private async fcm(delivery: PushDelivery): Promise<'sent' | 'invalidToken'> {
    const account = JSON.parse(readFileSync(this.env.GOOGLE_APPLICATION_CREDENTIALS!, 'utf8')) as Record<string, unknown>
    if (account.type !== 'service_account' || typeof account.client_email !== 'string' || typeof account.private_key !== 'string' || typeof account.project_id !== 'string') throw new Error('FCM requires an explicit service-account ADC file')
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url')}`
    const access = await (this.io.fetch ?? fetch)('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
    if (!access.ok) throw new Error(`FCM authorization failed (${access.status})`)
    const auth = await access.json() as { access_token?: string }
    if (!auth.access_token) throw new Error('FCM authorization returned no access token')
    const response = await (this.io.fetch ?? fetch)(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { token: delivery.token, ...delivery.payload } }) })
    if (response.ok) return 'sent'
    const body = await response.text()
    if (response.status === 404 && body.includes('UNREGISTERED')) return 'invalidToken'
    throw new Error(`FCM rejected delivery (${response.status})`)
  }
}

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

/** The proxy configured in the app's network settings; direct when unavailable. */
async function networkProxyOptions(url: string): Promise<Record<string, unknown>> {
  try {
    return getNetworkProxyFetchOptions(await loadNetworkSettings(), url) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Expo Push Service relays to APNs / FCM with the credentials the publisher uploaded to EAS. */
export class ExpoPushTransport implements PushTransport {
  constructor(private io: { fetch?: (url: string, init: RequestInit) => Promise<Response>; fetchOptions?: (url: string) => Promise<Record<string, unknown>> } = {}) {}
  configured() { return true }
  async send(delivery: PushDelivery): Promise<'sent' | 'invalidToken'> {
    if (delivery.kind !== 'notification') throw new Error('Expo push only carries ordinary notifications')
    // Many desktops reach the internet only through the proxy set in cc-haha.
    const proxy = await (this.io.fetchOptions ?? (this.io.fetch ? async () => ({}) : networkProxyOptions))(EXPO_PUSH_URL)
    const response = await (this.io.fetch ?? fetch)(EXPO_PUSH_URL, { ...proxy, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify([{ ...delivery.payload, to: delivery.token }]) })
    if (!response.ok) throw new Error(`Expo push rejected delivery (${response.status})`)
    const body = await response.json().catch(() => undefined) as { data?: { status?: string; details?: { error?: string } }[] } | undefined
    const ticket = Array.isArray(body?.data) ? body.data[0] : undefined
    if (ticket?.status === 'ok') return 'sent'
    if (ticket?.details?.error === 'DeviceNotRegistered') return 'invalidToken'
    throw new Error(`Expo push rejected delivery (${ticket?.details?.error ?? 'invalid response'})`)
  }
}

export type PulledNotification = { id: string } & Record<string, unknown>
type Queued = { id: string; payload: Record<string, unknown>; expiresAt: number }
/**
 * Longer than APNs keeps an alert (5 min): a phone that slept through a dropped
 * connection reconnects on its next system alarm, which Android may defer for minutes.
 */
const QUEUE_TTL_MS = 10 * 60_000
const QUEUE_LIMIT = 32
const queueKey = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * For phones without a usable push service (most Android phones in mainland China):
 * the phone's foreground service long-polls this computer. Alerts wait here until
 * the phone acknowledges them or they expire.
 */
export class DesktopPullTransport implements PushTransport {
  private queues = new Map<string, Queued[]>()
  private waiters = new Map<string, Set<() => void>>()
  constructor(private now: () => number = Date.now) {}
  configured() { return true }
  async send(delivery: PushDelivery): Promise<'sent' | 'invalidToken'> {
    if (delivery.kind !== 'notification') throw new Error('Pulled push only carries ordinary notifications')
    const key = queueKey(delivery.token)
    this.queues.set(key, [...this.live(key), { id: randomUUID(), payload: delivery.payload, expiresAt: this.now() + QUEUE_TTL_MS }].slice(-QUEUE_LIMIT))
    for (const wake of [...this.waiters.get(key) ?? []]) wake()
    return 'sent'
  }
  /** Everything after `ack`; waits up to `holdMs` when nothing is pending. */
  async pull(token: string, ack: string | undefined, signal: AbortSignal, holdMs = 25_000): Promise<PulledNotification[]> {
    const key = queueKey(token)
    let queue = this.live(key)
    const acknowledged = ack ? queue.findIndex(item => item.id === ack) : -1
    if (acknowledged >= 0) queue = queue.slice(acknowledged + 1)
    if (queue.length) this.queues.set(key, queue); else this.queues.delete(key)
    if (!queue.length && holdMs > 0 && !signal.aborted) {
      await new Promise<void>(resolve => {
        const waiters = this.waiters.get(key) ?? new Set<() => void>()
        const done = () => {
          clearTimeout(timer); signal.removeEventListener('abort', done)
          waiters.delete(done); if (!waiters.size) this.waiters.delete(key)
          resolve()
        }
        const timer = setTimeout(done, holdMs)
        signal.addEventListener('abort', done)
        waiters.add(done)
        this.waiters.set(key, waiters)
      })
      queue = this.live(key)
    }
    return queue.map(item => ({ ...item.payload, id: item.id }))
  }
  forget(token: string) { this.queues.delete(queueKey(token)) }
  private live(key: string) { return (this.queues.get(key) ?? []).filter(item => item.expiresAt > this.now()) }
}

/** Routes each delivery to the transport its registration chose. */
export class MobilePushRouter implements PushTransport {
  constructor(readonly direct: PushTransport = new DirectMobilePushTransport(), readonly expo: PushTransport = new ExpoPushTransport(), readonly desktop = new DesktopPullTransport()) {}
  configured(platform: MobilePushPlatform, provider?: MobilePushProvider) {
    if (provider === 'expo') return this.expo.configured(platform)
    if (provider === 'desktop') return platform === 'android' && this.desktop.configured()
    return this.direct.configured(platform)
  }
  send(delivery: PushDelivery) {
    return delivery.provider === 'expo' ? this.expo.send(delivery) : delivery.provider === 'desktop' ? this.desktop.send(delivery) : this.direct.send(delivery)
  }
}
