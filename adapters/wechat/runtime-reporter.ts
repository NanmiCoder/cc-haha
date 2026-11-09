import { randomUUID } from 'node:crypto'

export type WechatConnectionState = 'starting' | 'online' | 'reconnecting' | 'auth_expired' | 'error' | 'stopped'
export type WechatRuntimeReport = {
  state: WechatConnectionState
  lastPollOkAt?: number
  lastReceiveAt?: number
  lastSendAt?: number
  errorCode?: string
}

/** The local server owns expiry and leases. No WeChat credential or message body
 * crosses this boundary. A revoked worker must not re-register itself. */
export class WechatRuntimeReporter {
  private leaseId: string | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private active: Promise<void> | undefined
  private disabled = false
  private readonly instanceId = randomUUID()
  private readonly startedAt = Date.now()
  private report: WechatRuntimeReport = { state: 'starting' }
  private readonly baseUrl: string

  constructor(private readonly options: {
    serverUrl: string
    token?: string
    fetch?: typeof fetch
    onSuperseded?: () => void
    intervalMs?: number
  }) {
    this.baseUrl = options.serverUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '')
  }

  start(): void {
    if (this.timer || this.disabled) return
    void this.flush()
    this.timer = setInterval(() => { void this.flush() }, this.options.intervalMs ?? 15_000)
    this.timer.unref?.()
  }

  update(patch: Partial<WechatRuntimeReport>): void {
    this.report = { ...this.report, ...patch }
    if (this.timer) void this.flush()
  }

  async flush(): Promise<void> {
    if (this.disabled) return
    if (this.active) return this.active
    this.active = this.send().catch(() => {
      // No fabricated heartbeat: the server will mark the last report stale.
    }).finally(() => { this.active = undefined })
    return this.active
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.active
    this.report.state = 'stopped'
    await this.flush()
    this.disabled = true
  }

  private async request(endpoint: string, body: object): Promise<Response> {
    return (this.options.fetch ?? fetch)(`${this.baseUrl}/api/adapters/wechat/runtime/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}) },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000),
    })
  }

  private async send(): Promise<void> {
    if (!this.leaseId) {
      const response = await this.request('register', { instanceId: this.instanceId, startedAt: this.startedAt })
      if (response.status === 409) {
        this.disabled = true
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
        this.options.onSuperseded?.()
        return
      }
      if (!response.ok) return
      const body = await response.json() as { leaseId?: unknown }
      if (typeof body.leaseId !== 'string' || !body.leaseId) return
      this.leaseId = body.leaseId
    }
    const response = await this.request('report', { leaseId: this.leaseId, ...this.report })
    if (response.status === 409) {
      this.disabled = true
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      this.options.onSuperseded?.()
    }
  }
}
