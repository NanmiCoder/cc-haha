import { ApiError } from '../core/client'

export type PushStatus = 'loading' | 'registered' | 'notConfigured' | 'permissionRequired' | 'unsupported' | 'error'
export type PushIssue = 'network' | 'authorization' | 'hostUnsupported' | 'deviceNotConfigured' | 'deviceUnavailable' | 'storage' | 'unknown'
export type PushInfo = { status: PushStatus; issue?: PushIssue; error?: string }
export type PushStage = 'permission' | 'device' | 'host' | 'registration'
type AttemptResult = { info: PushInfo; retry?: boolean }

/** Keep native token availability separate from computer transport and stored proofs. */
export function pushRegistrationFailure(error: unknown, stage: PushStage): AttemptResult {
  const message = error instanceof Error ? error.message : '通知登记失败'
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (stage === 'device') {
    if (code === 'NOT_CONFIGURED')
      return { info: { status: 'unsupported', issue: 'deviceNotConfigured', error: message } }
    return { info: { status: 'error', issue: 'deviceUnavailable', error: message }, retry: code === 'UNAVAILABLE' || code === 'TIMEOUT' }
  }
  if (error instanceof ApiError) {
    if ([401, 403].includes(error.status))
      return { info: { status: 'error', issue: 'authorization', error: message } }
    if ([404, 405].includes(error.status))
      return { info: { status: 'unsupported', issue: 'hostUnsupported', error: message } }
    if (['NETWORK_ERROR', 'TIMEOUT'].includes(error.code ?? '') || [502, 503, 504].includes(error.status))
      return { info: { status: 'error', issue: 'network', error: message }, retry: true }
  }
  return { info: { status: 'error', issue: stage === 'registration' && !(error instanceof ApiError) ? 'storage' : 'unknown', error: message } }
}

const retryDelays = [2000, 5000, 15000]

/** Serialize registration; only fresh native tokens may start work in background. */
export class PushRegistrationRecovery {
  private alive = true
  private active = false
  private running = false
  private pending = false
  private pendingToken: string | undefined
  private retryCount = 0
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private request: AbortController | undefined

  constructor(
    private attempt: (signal: AbortSignal, token?: string) => Promise<AttemptResult>,
    private update: (info: PushInfo) => void
  ) {}

  setActive(active: boolean) {
    if (!this.alive || this.active === active) return
    this.active = active
    this.generation++
    this.clearTimer()
    if (active) {
      // A foreground check reads the current native token again.
      this.pendingToken = undefined
      this.refresh()
    } else {
      // Keep the latest rotation queued behind the in-flight request. Ordinary
      // refreshes still stop here, while a rotated token gets one background try.
      this.pending = Boolean(this.pendingToken)
      // Let an accepted registration finish. Aborting its signal would ask the
      // coordinator to revoke it, precisely when background push is needed.
    }
  }

  refresh(token?: string) {
    if (!this.alive || (!this.active && !token)) return
    this.clearTimer()
    this.retryCount = 0
    if (this.running) {
      this.pending = true
      if (token) this.pendingToken = token
      return
    }
    void this.run(token)
  }

  stop() {
    this.alive = false
    this.active = false
    this.generation++
    this.pending = false
    this.pendingToken = undefined
    this.clearTimer()
    this.request?.abort()
  }

  private clearTimer() {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private async run(token?: string) {
    if (!this.alive || (!this.active && !token)) return
    this.running = true
    const request = new AbortController()
    this.request = request
    const generation = this.generation
    const current = () => this.alive && this.active && this.generation === generation && !request.signal.aborted && this.request === request
    let retry = false
    if (this.active) this.update({ status: 'loading' })
    try {
      const result = await this.attempt(request.signal, token)
      if (current()) {
        this.update(result.info)
        retry = Boolean(result.retry)
      }
    } catch (error) {
      if (current()) this.update(pushRegistrationFailure(error, 'permission').info)
    } finally {
      this.running = false
      if (this.alive && this.pending && (this.active || this.pendingToken)) {
        const next = this.pendingToken
        this.pending = false
        this.pendingToken = undefined
        void this.run(next)
      } else if (current() && retry) {
        const delay = retryDelays[this.retryCount++]
        if (delay !== undefined)
          this.timer = setTimeout(() => {
            this.timer = undefined
            void this.run()
          }, delay)
      }
    }
  }
}
