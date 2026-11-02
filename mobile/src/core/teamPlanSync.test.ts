import { describe, expect, test } from 'bun:test'
import { ApiError } from './client'
import type { TeamPlanRecord } from './teamPlan'
import { TeamPlanSync } from './teamPlanSync'

const plan = (patch: Partial<TeamPlanRecord> = {}): TeamPlanRecord => ({
  schemaVersion: 1,
  planId: 'plan-1',
  sessionId: 'session-1',
  teamName: 'taskboard',
  incarnationId: 'inc-1',
  revision: 2,
  state: 'review_pending',
  workDir: '/fixture',
  leaderRuntime: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  members: [{ id: 'm1', name: 'builder', agentType: 'general-purpose', prompt: 'build', runtime: { providerId: 'deepseek', modelId: 'deepseek-flash' } }],
  tasks: [{ id: 't1', subject: 'build', ownerId: 'm1', dependencies: [] }],
  createdAt: 1,
  updatedAt: 2,
  ...patch,
})

type Call = { method: string; path: string; body?: Record<string, unknown> }
type Reply = TeamPlanRecord | null | Error | Promise<TeamPlanRecord | null>

/** 按调用顺序给出回复的假客户端；记录每次请求，方便核对 requestId 和重读。 */
function harness(replies: Reply[]) {
  const calls: Call[] = []
  const respond = async () => {
    const next = replies.shift()
    if (next === undefined) throw new Error('unexpected request')
    const value = await next
    if (value instanceof Error) throw value
    return { plan: value }
  }
  const client = {
    get: (path: string) => { calls.push({ method: 'GET', path }); return respond() },
    patch: (path: string, body?: unknown) => { calls.push({ method: 'PATCH', path, body: body as Record<string, unknown> }); return respond() },
    post: (path: string, body?: unknown) => { calls.push({ method: 'POST', path, body: body as Record<string, unknown> }); return respond() },
  } as never
  let ids = 0
  const sync = new TeamPlanSync(client, 'session-1', () => `request-${++ids}`)
  return { sync, calls }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('team plan sync', () => {
  test('a retried approval reuses its request id so the computer cannot launch the team twice', async () => {
    const { sync, calls } = harness([plan(), new ApiError('无法连接服务器', 0, 'NETWORK_ERROR'), plan({ state: 'running', revision: 3 })])
    await sync.load()
    expect(await sync.act('approve')).toBe(false)
    expect(sync.snapshot.error).toBe('无法连接服务器')
    expect(await sync.act('approve')).toBe(true)
    const approvals = calls.filter((call) => call.path.endsWith('/approve'))
    expect(approvals.map((call) => call.body?.requestId)).toEqual(['request-1', 'request-1'])
    expect(sync.snapshot.plan?.state).toBe('running')
    expect(sync.snapshot.error).toBe('')
  })

  test('a plan changed elsewhere (409) is read again and the reason stays visible', async () => {
    const { sync, calls } = harness([
      plan(),
      new ApiError('Plan changed; refresh before continuing', 409, 'TEAM_PLAN_CONFLICT'),
      plan({ revision: 5 }),
    ])
    await sync.load()
    expect(await sync.edit({ tasks: [{ id: 't1', ownerId: 'm1' }] })).toBe(false)
    await settle()
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET'])
    expect(sync.snapshot.plan?.revision).toBe(5)
    expect(sync.snapshot.error).toContain('方案刚在别处更新过')
  })

  test('a plan removed elsewhere (404) is read again, so the review entry goes away', async () => {
    const { sync, calls } = harness([plan(), new ApiError('Plan not found', 404, 'TEAM_PLAN_CONFLICT'), null])
    await sync.load()
    expect(await sync.act('approve')).toBe(false)
    await settle()
    expect(calls.at(-1)?.method).toBe('GET')
    expect(sync.snapshot.plan).toBeNull()
  })

  test('only the latest read counts, and an older revision never replaces a newer one', async () => {
    let releaseOld!: (value: TeamPlanRecord) => void
    const old = new Promise<TeamPlanRecord>((resolve) => { releaseOld = resolve })
    const { sync } = harness([old, null])
    const first = sync.load()
    await sync.load()
    expect(sync.snapshot.plan).toBeNull()
    // 团队删掉之前发起的读取迟到，不能把已经没有的方案又放回来。
    releaseOld(plan())
    await first
    expect(sync.snapshot.plan).toBeNull()

    const later = harness([plan({ revision: 4 }), plan({ revision: 3 })])
    await later.sync.load()
    await later.sync.load()
    expect(later.sync.snapshot.plan?.revision).toBe(4)
  })

  test('one change at a time: a second action while one is in flight is not sent', async () => {
    let release!: (value: TeamPlanRecord) => void
    const slow = new Promise<TeamPlanRecord>((resolve) => { release = resolve })
    const { sync, calls } = harness([plan(), slow])
    await sync.load()
    const edit = sync.edit({ members: [{ id: 'm1', agentType: 'reviewer' }] })
    expect(sync.snapshot.pending).toBe('edit')
    expect(await sync.act('approve')).toBe(false)
    release(plan({ revision: 3 }))
    expect(await edit).toBe(true)
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(1)
    expect(sync.snapshot.pending).toBeNull()
  })

  test('listeners hear every change and can unsubscribe', async () => {
    const { sync } = harness([plan(), plan({ revision: 3 })])
    let heard = 0
    const stop = sync.subscribe(() => { heard++ })
    await sync.load()
    expect(heard).toBe(1)
    stop()
    await sync.load()
    expect(heard).toBe(1)
    expect(sync.snapshot.plan?.revision).toBe(3)
  })
})
