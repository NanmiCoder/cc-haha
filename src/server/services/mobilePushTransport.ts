import { existsSync, readFileSync } from 'node:fs'
import { sign } from 'node:crypto'
import { connect, type ClientHttp2Session } from 'node:http2'

export type MobilePushPlatform = 'ios' | 'android'
export type PushDelivery = { token: string; platform: MobilePushPlatform; kind: 'notification' | 'liveActivity'; payload: Record<string, unknown> }
export type PushTransport = { configured(platform: MobilePushPlatform): boolean; send(delivery: PushDelivery): Promise<'sent' | 'invalidToken'> }
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
