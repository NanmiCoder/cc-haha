import { randomUUID } from 'node:crypto'

export type WechatRuntimeState = 'starting' | 'online' | 'reconnecting' | 'auth_expired' | 'error' | 'stopped'
export type WechatRuntimeReport = {
  state: WechatRuntimeState
  lastPollOkAt?: number
  lastReceiveAt?: number
  lastSendAt?: number
  errorCode?: string
}
export type WechatRuntimeSnapshot = Omit<WechatRuntimeReport, 'state'> & {
  state: WechatRuntimeState | 'stale'
  updatedAt?: number
  serverReachable: boolean
}

/** Ephemeral health only. Restarting the server must never restore an old green light. */
export class WechatRuntimeService {
  private leaseId: string | undefined
  private instanceId: string | undefined
  private latestStartedAt = -1
  private invalidatedAt = -1
  private snapshot: WechatRuntimeSnapshot = { state: 'stopped', serverReachable: false }
  constructor(private readonly now = Date.now) {}

  register(instanceId: string, startedAt: number): { leaseId: string } | null {
    if (this.leaseId && instanceId === this.instanceId && startedAt === this.latestStartedAt) return { leaseId: this.leaseId }
    if (startedAt <= this.latestStartedAt || startedAt < this.invalidatedAt) return null
    this.instanceId = instanceId
    this.latestStartedAt = startedAt
    this.leaseId = randomUUID()
    this.snapshot = { state: 'starting', serverReachable: true, updatedAt: this.now() }
    return { leaseId: this.leaseId }
  }

  report(leaseId: string, report: WechatRuntimeReport): boolean {
    if (!this.leaseId || leaseId !== this.leaseId) return false
    this.snapshot = { ...report, serverReachable: true, updatedAt: this.now() }
    return true
  }

  invalidate(): void {
    this.leaseId = undefined
    this.invalidatedAt = this.now()
    this.snapshot = { state: 'stopped', serverReachable: false, updatedAt: this.now() }
  }

  getSnapshot(): WechatRuntimeSnapshot {
    if (this.snapshot.updatedAt !== undefined && this.snapshot.state !== 'stopped'
      && this.now() - this.snapshot.updatedAt > 45_000) {
      return { ...this.snapshot, state: 'stale', serverReachable: false }
    }
    // A heartbeat only proves that the worker can reach this server. A stuck
    // poll must not keep the WeChat channel green indefinitely.
    if (this.snapshot.state === 'online' && (this.snapshot.lastPollOkAt === undefined
      || this.now() - this.snapshot.lastPollOkAt > 45_000)) {
      return { ...this.snapshot, state: 'stale' }
    }
    return { ...this.snapshot }
  }
}

export const wechatRuntimeService = new WechatRuntimeService()
