import { ApiError, type ApiClient } from './client'
import {
  actOnTeamPlan,
  actionKey,
  editTeamPlan,
  loadTeamPlan,
  newerTeamPlan,
  teamPlanErrorText,
  type TeamPlanAction,
  type TeamPlanEdit,
  type TeamPlanRecord,
} from './teamPlan'

export type TeamPlanPending = 'edit' | TeamPlanAction
export type TeamPlanSnapshot = {
  plan: TeamPlanRecord | null
  pending: TeamPlanPending | null
  error: string
}

/**
 * 方案在电脑上已经变了（别处改过、已开始启动）或已经没了（团队被删）：
 * 手里这份不能再用，要重新读取。
 */
const isStale = (error: unknown) => error instanceof ApiError && (error.status === 409 || error.status === 404)

/**
 * 一个会话的团队方案：读取、修改和操作都经过这里。改动直接保存到电脑，
 * 手机上没有“未保存”的草稿；失败时保留原方案并给出原因。
 */
export class TeamPlanSync {
  #snapshot: TeamPlanSnapshot = { plan: null, pending: null, error: '' }
  #listeners = new Set<() => void>()
  #loads = 0
  // 同一版本上的同一操作重试时沿用 requestId，电脑按幂等处理，不会启动两次。
  #requestIds = new Map<string, string>()

  constructor(
    private readonly client: Pick<ApiClient, 'get' | 'patch' | 'post'>,
    private readonly sessionId: string,
    private readonly newRequestId: () => string
  ) {}

  get snapshot() {
    return this.#snapshot
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #set(patch: Partial<TeamPlanSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) listener()
  }

  #accept(next: TeamPlanRecord | null) {
    const current = this.#snapshot.plan
    const plan = newerTeamPlan(current, next)
    if (plan === current) return
    // 换了方案或状态，之前那次操作的报错已经不适用。
    const moved = plan?.planId !== current?.planId || plan?.state !== current?.state
    this.#set({ plan, ...(moved ? { error: '' } : {}) })
  }

  /** 只采用最后发起的那次读取：先发后到的旧结果（包括团队已删前的方案）不能盖住新的。 */
  async load(signal?: AbortSignal) {
    const load = ++this.#loads
    try {
      const next = await loadTeamPlan(this.client, this.sessionId, signal)
      if (load === this.#loads && !signal?.aborted) this.#accept(next)
    } catch {
      // 读不到就保留上一次的结果，不打扰聊天；下一次信号或重连会再读。
    }
  }

  async #run(kind: TeamPlanPending, task: (plan: TeamPlanRecord) => Promise<TeamPlanRecord>) {
    const plan = this.#snapshot.plan
    if (!plan || this.#snapshot.pending) return false
    this.#set({ pending: kind, error: '' })
    try {
      const next = await task(plan)
      this.#set({ pending: null })
      this.#accept(next)
      return true
    } catch (error) {
      this.#set({ pending: null, error: teamPlanErrorText(error) })
      if (isStale(error)) void this.load()
      return false
    }
  }

  edit(edit: TeamPlanEdit) {
    return this.#run('edit', (plan) => editTeamPlan(this.client, plan, edit))
  }

  act(action: TeamPlanAction, feedback?: string) {
    return this.#run(action, async (plan) => {
      const key = actionKey(plan, action)
      const requestId = this.#requestIds.get(key) ?? this.newRequestId()
      this.#requestIds.set(key, requestId)
      const next = await actOnTeamPlan(this.client, plan, action, requestId, feedback)
      this.#requestIds.delete(key)
      return next
    })
  }
}
