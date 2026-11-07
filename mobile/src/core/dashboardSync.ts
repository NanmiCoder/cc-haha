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

/** slow=电脑回应太慢；offline=连不上；unauthorized=凭据被拒；failed=电脑回应了但读取失败。 */
export type DashboardFailure = 'slow' | 'offline' | 'unauthorized' | 'failed'
export function classifyDashboardError(error: unknown): DashboardFailure {
  if (!(error instanceof ApiError)) return 'failed'
  if ([401, 403].includes(error.status) || error.code === 'PAIRING_REQUIRED')
    return 'unauthorized'
  // 公网访问经中转时，睡着的电脑表现为网关错误。
  if (
    ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code ?? '') ||
    [502, 503, 504].includes(error.status)
  )
    return 'offline'
  return 'failed'
}

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

/**
 * 只刷新各会话的运行状态，会话列表沿用上一份。聊天页只需要这部分；
 * 上百条会话的列表每 3 秒经公网隧道整份拉一遍，会和聊天的连接抢带宽。
 */
export async function loadDashboardActivity(
  client: DashboardClient,
  signal: AbortSignal,
  now: () => number,
  previous: DashboardSnapshot
): Promise<DashboardSnapshot> {
  const checkedAt = now()
  const status = await client.get<{ sessions: MobileActivity[] }>(
    '/api/sessions/mobile-status',
    { signal }
  )
  if (!Array.isArray(status.sessions))
    throw new ApiError('电脑返回的任务状态无效', 0, 'INVALID_RESPONSE')
  return { ...previous, activity: status.sessions, checkedAt }
}

/** full：会话列表和运行状态；activity：只刷新运行状态（聊天页）。 */
export type DashboardScope = 'full' | 'activity'
const POLL_MS: Record<DashboardScope, number> = { full: 3000, activity: 5000 }
/** 回到前台后最多等聊天连接这么久，再发首页的同步请求。 */
export const RESUME_YIELD_MS = 1500
export type DashboardGate = { readonly busy: boolean; whenIdle(maxMs: number): Promise<void> }

type Callbacks = {
  snapshot(value: DashboardSnapshot): void
  fresh(value: boolean): void
  loading(value: boolean): void
  /** 空字符串表示恢复；kind 让界面区分离线、授权失效和读取失败。 */
  error(value: string, kind?: DashboardFailure): void
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
  private last?: DashboardSnapshot
  private scope: DashboardScope = 'full'
  /** 连续连不上的次数；已有快照时第一次失败只算“正在重试”，不立刻判离线。 */
  private offlineStreak = 0
  private epoch = 0
  private request?: AbortController
  private pollTimer: unknown
  private freshnessTimer: unknown
  constructor(
    private client: DashboardClient,
    private callbacks: Callbacks,
    private clock: Timers = timers,
    private load = loadDashboardSnapshot,
    private gate?: DashboardGate,
    private loadActivity = loadDashboardActivity
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
    if (active) {
      // 聊天正在和电脑重新对齐时先让它用链路，等它好了（或等够了）再同步首页。
      if (!this.gate?.busy) this.refresh()
      else {
        const epoch = this.epoch
        void this.gate.whenIdle(RESUME_YIELD_MS).then(() => {
          if (this.alive && this.active && this.epoch === epoch) this.refresh()
        })
      }
    } else {
      this.pending = false
      this.request?.abort()
      this.callbacks.loading(false)
    }
  }
  setScope(scope: DashboardScope) {
    if (this.scope === scope) return
    this.scope = scope
    // 回到需要完整列表的页面时立即补一份，不等下一轮。
    if (scope === 'full') this.refresh()
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
      const snapshot =
        this.scope === 'activity' && this.last?.hostId === this.client.host.id
          ? await this.loadActivity(this.client, request.signal, this.clock.now, this.last)
          : await this.load(this.client, request.signal, this.clock.now)
      if (current()) {
        this.hasSnapshot = true
        this.last = snapshot
        this.offlineStreak = 0
        this.callbacks.snapshot(snapshot)
        const remaining = snapshot.checkedAt + 12000 - this.clock.now()
        if (remaining > 0) this.callbacks.error('')
        else this.callbacks.error('电脑状态更新耗时较长，正在重新同步', 'slow')
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
        const kind = classifyDashboardError(error)
        this.offlineStreak = kind === 'offline' ? this.offlineStreak + 1 : 0
        // 一次网络抖动不应把首页切到离线卡；连续两次连不上才算离线。
        if (kind === 'offline' && this.hasSnapshot && this.offlineStreak < 2)
          this.callbacks.error('连接不太稳定，正在重试', 'slow')
        else
          this.callbacks.error(
            error instanceof Error ? error.message : '无法同步电脑状态',
            kind
          )
      }
    } finally {
      this.inFlight = false
      if (this.alive && this.active) {
        this.callbacks.loading(false)
        if (this.pending) {
          this.pending = false
          this.refresh()
        } else this.pollTimer = this.clock.set(() => this.refresh(), POLL_MS[this.scope])
      }
    }
  }
}
