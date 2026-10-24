import { ApiError, type ApiClient } from './client'
import type { Session } from './types'
import type { MobileActivity } from './dashboard'

export type DashboardSnapshot = {
  hostId: string
  sessions: Session[]
  activity: MobileActivity[]
  total: number
  checkedAt: number
}
type DashboardClient = Pick<ApiClient, 'host' | 'get'>
const pageSize = 500

/** The desktop's offset advances over index rows, including unreadable rows it
 * filters from a response. A short page therefore does not mean end-of-list. */
export async function loadDashboardSnapshot(
  client: DashboardClient,
  signal: AbortSignal,
  now: () => number = Date.now
): Promise<DashboardSnapshot> {
  const sessions = new Map<string, Session>()
  let offset = 0,
    total = 0
  do {
    const page = await client.get<{ sessions: Session[]; total: number }>(
      `/api/sessions?limit=${pageSize}&offset=${offset}`,
      { signal }
    )
    if (
      !Array.isArray(page.sessions) ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0
    )
      throw new ApiError('电脑返回的会话分页无效', 0, 'INVALID_RESPONSE')
    for (const session of page.sessions) sessions.set(session.id, session)
    total = page.total
    offset += pageSize
  } while (offset < total)
  // Read activity after pagination so a large history cannot age an approval
  // snapshot while its remaining pages are still being fetched.
  const checkedAt = now()
  const status = await client.get<{ sessions: MobileActivity[] }>(
    '/api/sessions/mobile-status',
    { signal }
  )
  const missing = [
    ...new Set(
      status.sessions
        .filter(
          (item) =>
            ['running', 'waiting'].includes(item.activityState) &&
            !sessions.has(item.id)
        )
        .map((item) => item.id)
    ),
  ]
  for (const id of missing) {
    // A session can move between offset pages while its task is running. The
    // summary endpoint resolves its real metadata without loading its transcript.
    const session = await client.get<Session>(
      `/api/sessions/${encodeURIComponent(id)}/summary`,
      { signal }
    )
    if (session.id !== id)
      throw new ApiError('电脑返回的任务信息不匹配', 0, 'INVALID_RESPONSE')
    sessions.set(id, session)
  }
  return {
    hostId: client.host.id,
    sessions: [...sessions.values()],
    activity: status.sessions,
    total: Math.max(total, sessions.size),
    checkedAt,
  }
}

type Callbacks = {
  snapshot(value: DashboardSnapshot): void
  fresh(value: boolean): void
  loading(value: boolean): void
  error(value: string): void
}
type Timers = {
  set(task: () => void, delay: number): unknown
  clear(timer: unknown): void
  now(): number
}
const timers: Timers = {
  set: (task, delay) => setTimeout(task, delay),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: Date.now,
}

/** Foreground-only polling with an explicit freshness lease. Resume always
 * revalidates; an in-flight request from a previous foreground cannot revive it. */
export class DashboardPoller {
  private alive = false
  private active = false
  private inFlight = false
  private pending = false
  private hasSnapshot = false
  private epoch = 0
  private request?: AbortController
  private pollTimer: unknown
  private freshnessTimer: unknown
  constructor(
    private client: DashboardClient,
    private callbacks: Callbacks,
    private clock: Timers = timers,
    private load = loadDashboardSnapshot
  ) {}

  start(active = true) {
    this.alive = true
    this.callbacks.fresh(false)
    this.setActive(active)
  }
  setActive(active: boolean) {
    if (!this.alive || this.active === active) return
    this.active = active
    this.epoch++
    this.callbacks.fresh(false)
    this.clock.clear(this.pollTimer)
    this.clock.clear(this.freshnessTimer)
    if (active) this.refresh()
    else {
      this.pending = false
      this.request?.abort()
      this.callbacks.loading(false)
    }
  }
  refresh() {
    if (!this.alive || !this.active) return
    this.clock.clear(this.pollTimer)
    if (this.inFlight) {
      this.pending = true
      return
    }
    void this.poll()
  }
  stop() {
    this.alive = false
    this.active = false
    this.epoch++
    this.request?.abort()
    this.clock.clear(this.pollTimer)
    this.clock.clear(this.freshnessTimer)
  }
  private async poll() {
    this.inFlight = true
    const epoch = this.epoch
    const request = new AbortController()
    this.request = request
    if (!this.hasSnapshot) this.callbacks.loading(true)
    const current = () =>
      this.alive &&
      this.active &&
      this.epoch === epoch &&
      !request.signal.aborted
    try {
      const snapshot = await this.load(
        this.client,
        request.signal,
        this.clock.now
      )
      if (current()) {
        this.hasSnapshot = true
        this.callbacks.snapshot(snapshot)
        const remaining = snapshot.checkedAt + 12000 - this.clock.now()
        this.callbacks.error(
          remaining > 0 ? '' : '电脑状态更新耗时较长，正在重新同步'
        )
        this.callbacks.fresh(remaining > 0)
        this.clock.clear(this.freshnessTimer)
        if (remaining > 0)
          this.freshnessTimer = this.clock.set(() => {
            if (current()) this.callbacks.fresh(false)
          }, remaining)
      }
    } catch (error) {
      if (current()) {
        this.clock.clear(this.freshnessTimer)
        this.callbacks.fresh(false)
        this.callbacks.error(
          error instanceof Error ? error.message : '无法同步电脑状态'
        )
      }
    } finally {
      this.inFlight = false
      if (this.alive && this.active) {
        this.callbacks.loading(false)
        if (this.pending) {
          this.pending = false
          this.refresh()
        } else this.pollTimer = this.clock.set(() => this.refresh(), 3000)
      }
    }
  }
}
