import { describe, expect, test } from 'bun:test'
import { ApiClient } from './client'
import type { BackgroundTask } from './operations'
import {
  ACTIVE_POLL_MS,
  ActivityStore,
  STOP_TIMEOUT_MS,
  TEAM_RECHECK_MS,
  capsuleVisible,
  commandRows,
  createActivityFetcher,
  deriveActivity,
  memberMark,
  teamMembersAllStopped,
  planTasks,
  pollDelay,
  sectionSummaries,
  subagentRows,
  subagentStats,
  teamModel,
  type ActivityConfig,
  type ActivityFetchResult,
  type ActivityFetcher,
} from './sessionActivityModel'
import { runKey, taskKey } from './subagentLive'
import type { ClientMessage, SubagentLive } from './types'
import type { TaskInfo, TeamMember, TeamWorkbenchSessionTimeline } from '../ui/activity/activityData'

const info = (patch: Partial<TaskInfo>): TaskInfo => ({
  id: '1',
  subject: '任务',
  description: '',
  status: 'pending',
  blocks: [],
  blockedBy: [],
  taskListId: 's',
  ...patch,
})
const bg = (patch: Partial<BackgroundTask>): BackgroundTask => ({
  taskId: 't',
  status: 'running',
  taskType: 'local_bash',
  description: 'bun run bench',
  ...patch,
})
const agent = (patch: Partial<BackgroundTask> = {}) =>
  bg({ taskId: 'a1', taskType: 'local_agent', toolUseId: 'tool-a1', description: 'explorer', ...patch })
const member = (patch: Partial<TeamMember>): TeamMember => ({
  agentId: 'builder@team',
  name: 'builder',
  status: 'running',
  ...patch,
})
const timeline = (members: TeamMember[], tasks: TaskInfo[] = [], patch: Partial<TeamWorkbenchSessionTimeline> = {}, deletedAt?: string): TeamWorkbenchSessionTimeline => ({
  sessionId: 's',
  teamName: 'team',
  incarnationId: 'i1',
  source: 'live',
  snapshots: [
    {
      version: '1',
      generatedAt: '',
      ...(deletedAt ? { deletedAt } : {}),
      tasks,
      messages: [],
      team: { name: 'team', incarnationId: 'i1', leadSessionId: 's', leadAgentId: 'lead@team', createdAt: 1, members },
    },
  ],
  ...patch,
})
const data = (patch: Partial<Parameters<typeof deriveActivity>[0]> = {}) => ({
  tasks: [],
  team: null,
  background: [],
  stopping: {},
  ...patch,
})

describe('任务清单', () => {
  const tasks = [
    info({ id: '1', subject: '读取现有配对流程', status: 'completed' }),
    info({ id: '2', subject: '拆分扫码页与连接校验', status: 'in_progress', activeForm: '正在拆分扫码页' }),
    info({ id: '3', subject: '改进手机 Composer' }),
    info({ id: '4', subject: '回归验证', blockedBy: ['2'], owner: 'reviewer' }),
  ]
  test('四种状态：完成、进行中（带 activeForm）、待开始、等待依赖（带 owner）', () => {
    expect(planTasks(tasks)).toEqual([
      { id: '1', title: '读取现有配对流程', state: 'done' },
      { id: '2', title: '拆分扫码页与连接校验', state: 'active', detail: '正在拆分扫码页' },
      { id: '3', title: '改进手机 Composer', state: 'todo' },
      { id: '4', title: '回归验证', state: 'waiting', owner: 'reviewer' },
    ])
  })
  test('依赖已完成就回到待开始；进行中没有 activeForm 就不编造说明', () => {
    const rows = planTasks([
      info({ id: '1', status: 'completed' }),
      info({ id: '2', blockedBy: ['1'] }),
      info({ id: '3', status: 'in_progress', activeForm: '  ' }),
    ])
    expect(rows[1]?.state).toBe('todo')
    expect(rows[2]).not.toHaveProperty('detail')
  })
  test('进度：完成数/总数，active 取进行中任务的 activeForm，缺省用标题', () => {
    expect(deriveActivity(data({ tasks })).progress).toEqual({ done: 1, total: 4, active: '正在拆分扫码页' })
    const bare = [info({ status: 'in_progress', subject: '做事' })]
    expect(deriveActivity(data({ tasks: bare })).progress.active).toBe('做事')
    expect(deriveActivity(data()).progress).toEqual({ done: 0, total: 0 })
  })
  test('团队在跑时进度看团队看板，任务不再单列（挂到成员名下）', () => {
    const team = timeline([member({})], [info({ id: 'x', status: 'completed' }), info({ id: 'y' })])
    expect(deriveActivity(data({ team })).progress).toMatchObject({ done: 1, total: 2 })
    const model = deriveActivity(data({ team, tasks }))
    expect(model.progress).toMatchObject({ done: 1, total: 2 })
    expect(model.tasks).toEqual([])
  })
  test('团队已归档：回到会话自己的清单', () => {
    const archived = timeline([member({})], [info({ id: 'x' })], { source: 'archive' })
    const model = deriveActivity(data({ team: archived, tasks }))
    expect(model.progress.total).toBe(4)
    expect(model.tasks).toHaveLength(4)
    expect(deriveActivity(data({ team: archived })).progress.total).toBe(1)
  })
})

describe('子 Agent 与后台命令', () => {
  const live: Record<string, SubagentLive> = {
    [runKey('a1')]: {
      reads: ['/a', '/b', '/c'],
      steps: [
        { toolUseId: '1', toolName: 'Read', input: { file_path: '/repo/src/a.ts' }, done: true },
        { toolUseId: '2', toolName: 'Read', input: { file_path: '/repo/src/b.ts' }, done: true },
        { toolUseId: '3', toolName: 'Read', input: { file_path: '/repo/src/c.ts' }, done: false },
      ],
    },
    [taskKey('a1')]: { reads: [], steps: [], toolUses: 8 },
  }
  test('运行中的子 Agent：读文件数、最近两步（相对路径）、当前一步未完成', () => {
    const [row] = subagentRows([agent({ startedAt: '2026-10-25T10:00:00.000Z' })], live, {}, '/repo')
    expect(row).toMatchObject({ id: 'a1', title: 'explorer', status: 'running', stats: '已读取 3 个文件' })
    expect(row?.startedAt).toBe(Date.parse('2026-10-25T10:00:00.000Z'))
    expect(row?.steps).toEqual([
      { verb: '读取', object: 'src/b.ts', mono: true, done: true, error: false },
      { verb: '读取', object: 'src/c.ts', mono: true, done: false, error: false },
    ])
  })
  test('没有实时数据时不显示步骤和统计，更不编造', () => {
    const [row] = subagentRows([agent()], undefined, {})
    expect(row?.steps).toEqual([])
    expect(row?.stats).toBeUndefined()
  })
  test('已完成的卡显示工具调用次数，不显示最近步骤', () => {
    const [row] = subagentRows([agent({ status: 'completed' })], live, {})
    expect(row).toMatchObject({ stats: '8 次工具调用', steps: [] })
  })
  test('统计文案：运行中优先文件数，其次次数；结束后优先次数', () => {
    expect(subagentStats('running', { reads: 2, toolUses: 9 })).toBe('已读取 2 个文件')
    expect(subagentStats('running', { reads: 0, toolUses: 9 })).toBe('9 次工具调用')
    expect(subagentStats('completed', { reads: 2, toolUses: 9 })).toBe('9 次工具调用')
    expect(subagentStats('completed', { reads: 2 })).toBe('已读取 2 个文件')
    expect(subagentStats('running', { reads: 0 })).toBeUndefined()
    expect(subagentStats('running', null)).toBeUndefined()
  })
  test('运行中的排在前面，同状态保持原顺序；子 Agent 和命令各自分组', () => {
    const rows = [
      agent({ taskId: 'done', status: 'completed' }),
      agent({ taskId: 'run1' }),
      bg({ taskId: 'cmd-done', status: 'completed' }),
      agent({ taskId: 'run2' }),
      bg({ taskId: 'cmd-run' }),
    ]
    expect(subagentRows(rows, undefined, {}).map((row) => row.id)).toEqual(['run1', 'run2', 'done'])
    expect(commandRows(rows, {}).map((row) => row.id)).toEqual(['cmd-run', 'cmd-done'])
  })
  test('命令行显示最后一行输出；停止中来自本地请求或电脑标记', () => {
    const [row] = commandRows([bg({ result: 'a\nFixture: sample 1 / 20 …\n\n' })], { t: true })
    expect(row).toMatchObject({ command: 'bun run bench', lastLine: 'Fixture: sample 1 / 20 …', stopping: true })
    expect(commandRows([bg({ stopping: true })], {})[0]?.stopping).toBe(true)
    expect(commandRows([bg({})], {})[0]?.stopping).toBe(false)
  })
})

describe('runningCount 口径', () => {
  test('只数 running 的子 Agent 和后台命令；完成、停止、失败和团队成员不算', () => {
    const background = [
      agent({ taskId: 'a1' }),
      agent({ taskId: 'a2', status: 'completed' }),
      bg({ taskId: 'c1' }),
      bg({ taskId: 'c2', status: 'failed' }),
      bg({ taskId: 'c3', status: 'stopped' }),
    ]
    const team = timeline([member({ activity: 'active' })])
    const model = deriveActivity(data({ background, team }))
    expect(model.runningCount).toBe(2)
    // 胶囊角标和底单标题用的就是这一个数：分组摘要里的“运行中”加起来等于它。
    const summaries = sectionSummaries(model)
    const running = (text: string) => Number(/(\d+) 运行中/.exec(text)?.[1] ?? 0)
    expect(running(summaries.subagents) + running(summaries.commands)).toBe(model.runningCount)
  })
  test('tone：有待审批时 attention，否则 run', () => {
    expect(deriveActivity(data(), { pendingApprovals: 1 }).tone).toBe('attention')
    expect(deriveActivity(data(), { pendingApprovals: 0 }).tone).toBe('run')
    expect(deriveActivity(data()).tone).toBe('run')
  })
})

describe('胶囊可见性', () => {
  const progress = (done: number, total: number) => ({ done, total })
  test('没有任务也没有在跑的东西：不出现', () => {
    expect(capsuleVisible({ runningCount: 0, progress: progress(0, 0), turnActive: true })).toBe(false)
    expect(deriveActivity(data(), { turnActive: true }).capsuleVisible).toBe(false)
  })
  test('有后台在跑：出现，即使没有清单', () => {
    expect(capsuleVisible({ runningCount: 1, progress: progress(0, 0), turnActive: false })).toBe(true)
  })
  test('清单全部完成且这一轮已结束：消失；这一轮还在跑或还有没做完的：出现', () => {
    expect(capsuleVisible({ runningCount: 0, progress: progress(3, 3), turnActive: false })).toBe(false)
    expect(capsuleVisible({ runningCount: 0, progress: progress(3, 3), turnActive: true })).toBe(true)
    expect(capsuleVisible({ runningCount: 0, progress: progress(2, 3), turnActive: false })).toBe(true)
  })
  test('active：这一轮在跑或有东西在跑才转圈', () => {
    expect(deriveActivity(data({ tasks: [info({})] })).active).toBe(false)
    expect(deriveActivity(data({ tasks: [info({})] }), { turnActive: true }).active).toBe(true)
    expect(deriveActivity(data({ background: [bg({})] })).active).toBe(true)
  })
  test('队长这一轮已结束、成员还在干活：胶囊照样出现并转圈', () => {
    const working = deriveActivity(data({ team: timeline([member({ activity: 'active' })]) }))
    expect(working).toMatchObject({ active: true, capsuleVisible: true, runningCount: 0 })
    // 只有队长自己在跑不算：那是这段会话本身，由 turnActive 负责。
    const leadOnly = deriveActivity(data({ team: timeline([member({ agentId: 'lead@team', name: 'team-lead', activity: 'active' })]) }))
    expect(leadOnly).toMatchObject({ active: false, capsuleVisible: false })
  })
})

describe('团队', () => {
  test('队长、工作中、等待依赖、空闲各自的状态与说明', () => {
    const tasks = [
      info({ id: '1', owner: 'builder', status: 'in_progress', subject: '改 connectHost', activeForm: '编辑 connectHost.ts' }),
      info({ id: '2', owner: 'reviewer', blockedBy: ['1'], subject: '审查' }),
    ]
    const team = teamModel(
      timeline(
        [
          member({ agentId: 'lead@team', name: 'team-lead', activity: 'active' }),
          member({ activity: 'active' }),
          member({ agentId: 'reviewer@team', name: 'reviewer', activity: 'idle' }),
          member({ agentId: 'qa@team', name: 'qa', activity: 'idle' }),
        ],
        tasks
      )
    )
    expect(team?.members.map((row) => [row.name, row.state, row.detail, row.tone])).toEqual([
      ['队长', '工作中', undefined, 'run'],
      ['builder', '工作中', '编辑 connectHost.ts', 'run'],
      ['reviewer', '等待依赖', undefined, 'wait'],
      ['qa', '空闲', undefined, 'idle'],
    ])
    expect(team?.summary).toBe('team · 0/2 完成')
  })
  test('任务跟着负责人走：成员名下是它认领的看板任务，队长名下是会话自己的清单', () => {
    const board = [
      info({ id: '1', owner: 'backend-dev', status: 'completed', subject: '设计数据模型' }),
      info({ id: '2', owner: 'backend-dev@team', status: 'in_progress', subject: '实现 CRUD 接口', activeForm: '写路由' }),
      info({ id: '3', owner: 'frontend-dev', status: 'completed', subject: '搭页面骨架' }),
      info({ id: '4', owner: 'frontend-dev', blockedBy: ['2', '3'], subject: '接入接口' }),
      info({ id: '5', subject: '补 README' }),
      info({ id: '6', owner: 'someone-gone', subject: '旧成员的任务' }),
    ]
    const own = [info({ id: '1', subject: '拆分团队方案', status: 'completed' })]
    const team = teamModel(
      timeline(
        [
          member({ agentId: 'frontend-dev@team', name: 'frontend-dev', activity: 'idle', model: 'deepseek-v4.1-flash' }),
          member({ agentId: 'backend-dev@team', name: 'backend-dev', activity: 'active' }),
          member({ agentId: 'lead@team', name: 'team-lead', activity: 'idle' }),
        ],
        board
      ),
      own
    )!
    // 队长排第一；名下是自己的清单（没有看板编号，免得和 #1 混淆）。
    expect(team.members.map((row) => [row.name, row.mark, row.tasks.map((task) => task.ref ?? task.title)])).toEqual([
      ['队长', '队', ['拆分团队方案']],
      ['frontend-dev', 'FD', ['3', '4']],
      ['backend-dev', 'BD', ['1', '2']],
    ])
    const frontend = team.members[1]!
    expect(frontend).toMatchObject({ model: 'deepseek-v4.1-flash', state: '等待依赖', tone: 'wait' })
    // 只列还没完成的前置任务。
    expect(frontend.tasks[1]).toMatchObject({ key: 'team:4', state: 'waiting', waitingOn: ['2'] })
    expect(team.members[2]!.tasks[1]).toMatchObject({ state: 'active', detail: '写路由' })
    expect(team.unassigned.map((task) => task.ref)).toEqual(['5', '6'])
    expect(team.progress).toEqual({ done: 2, total: 6 })
    expect(team.summary).toBe('team · 2/6 完成')
  })
  test('成员头像取名字里前两个词的首字母，同队里不重复', () => {
    expect(['backend-dev', 'qa_reviewer', 'reviewer', 'team lead', 'x'].map((name) => memberMark(name))).toEqual(['BD', 'QR', 'RE', 'TL', 'X'])
    expect(memberMark('reviewer', new Set(['RE']))).toBe('RV')
    const team = teamModel(timeline([member({ agentId: 'r1', name: 'researcher' }), member({ agentId: 'r2', name: 'reviewer' })]))
    expect(team?.members.map((row) => row.mark)).toEqual(['RE', 'RV'])
  })
  test('成员都已停止或退出才算整组停下；队长不算，没有名单不算', () => {
    const team = (states: string[]) => ({ members: [{ lead: true, state: '工作中' }, ...states.map((state) => ({ lead: false, state }))] as never })
    expect(teamMembersAllStopped(team(['已停止', '已退出']))).toBe(true)
    expect(teamMembersAllStopped(team(['已停止', '空闲']))).toBe(false)
    expect(teamMembersAllStopped(team([]))).toBe(false)
    expect(teamMembersAllStopped(null)).toBe(false)
  })
  test('成员页：团队收尾归档后仍能找到成员（已退出）', () => {
    const archived = timeline([member({ activity: 'active' })], [info({ id: '1', owner: 'builder', status: 'completed' })], { source: 'archive' }, '2026-10-30T09:59:12Z')
    expect(teamModel(archived)).toBeNull()
    const team = teamModel(archived, [], { ended: true })
    expect(team?.members.map((row) => [row.name, row.state, row.tasks.map((task) => task.state)])).toEqual([['builder', '已退出', ['done']]])
    expect(teamModel({ ...archived, snapshots: [] }, [], { ended: true })).toBeNull()
  })
  test('归档、已删除、没有快照的团队不属于运行中', () => {
    expect(teamModel(null)).toBeNull()
    expect(teamModel(timeline([member({})], [], { source: 'archive' }))).toBeNull()
    expect(teamModel(timeline([member({})], [], {}, '2026-10-25T00:00:00Z'))).toBeNull()
    expect(teamModel({ ...timeline([]), snapshots: [] })).toBeNull()
  })
})

describe('分组摘要', () => {
  test('任务、子 Agent、后台命令的一句话', () => {
    const model = deriveActivity(
      data({
        tasks: [info({ id: '1', status: 'completed' }), info({ id: '2', status: 'in_progress' }), info({ id: '3' })],
        background: [agent({}), agent({ taskId: 'a2', status: 'completed' }), bg({}), bg({ taskId: 'c2', status: 'stopped' })],
      })
    )
    expect(sectionSummaries(model)).toMatchObject({
      tasks: '1/3 完成 · 1 进行中',
      subagents: '1 运行中 · 1 已完成',
      commands: '1 运行中 · 1 已结束',
    })
  })
})

describe('轮询条件', () => {
  const base = { enabled: true, visible: true, turnActive: false, backgroundIds: 0, running: 0, teamActive: false }
  test('空闲不轮询；运行、后台任务、团队工作中才轮询', () => {
    expect(pollDelay(base)).toBeNull()
    expect(pollDelay({ ...base, turnActive: true })).toBe(ACTIVE_POLL_MS)
    expect(pollDelay({ ...base, backgroundIds: 2 })).toBe(ACTIVE_POLL_MS)
    expect(pollDelay({ ...base, running: 1 })).toBe(ACTIVE_POLL_MS)
    expect(pollDelay({ ...base, teamActive: true })).toBe(ACTIVE_POLL_MS)
  })
  test('页面不可见或未启用时一律停', () => {
    expect(pollDelay({ ...base, turnActive: true, visible: false })).toBeNull()
    expect(pollDelay({ ...base, turnActive: true, enabled: false })).toBeNull()
  })
  test('活跃间隔在 3 到 4 秒之间', () => {
    expect(ACTIVE_POLL_MS).toBeGreaterThanOrEqual(3000)
    expect(ACTIVE_POLL_MS).toBeLessThanOrEqual(4000)
  })
})

/* ───────────── ActivityStore ───────────── */

class FakeTimers {
  now = 0
  #id = 0
  #timers = new Map<number, { at: number; callback: () => void }>()
  set = (callback: () => void, delay: number) => {
    const id = ++this.#id
    this.#timers.set(id, { at: this.now + delay, callback })
    return id
  }
  clear = (handle: unknown) => {
    this.#timers.delete(handle as number)
  }
  get pending() {
    return this.#timers.size
  }
  /** 推进时间并执行到期的定时器；每次执行后让出微任务，让异步读取完成。 */
  async advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const next = [...this.#timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.#timers.delete(next[0])
      this.now = next[1].at
      next[1].callback()
      await settle()
    }
    this.now = end
  }
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const config = (patch: Partial<ActivityConfig> = {}): ActivityConfig => ({
  enabled: true,
  visible: true,
  turnActive: false,
  backgroundKey: '',
  ...patch,
})

function harness(initial: Partial<ActivityFetchResult> = {}) {
  const timers = new FakeTimers()
  const calls: { team: boolean }[] = []
  const sent: ClientMessage[] = []
  let result: ActivityFetchResult = { errors: [], tasks: [], team: null, background: [], ...initial }
  let gate: Promise<void> | null = null
  const fetch: ActivityFetcher = async (signal, options) => {
    calls.push(options)
    if (gate) await gate
    if (signal.aborted) throw new Error('aborted')
    return { ...result, ...(options.team ? {} : { team: undefined }) }
  }
  const store = new ActivityStore({
    fetch,
    send: (message) => (sent.push(message), true),
    timers,
    now: () => timers.now,
  })
  return {
    store,
    timers,
    calls,
    sent,
    set: (next: Partial<ActivityFetchResult>) => (result = { ...result, ...next }),
    hold() {
      let release!: () => void
      gate = new Promise<void>((resolve) => (release = resolve))
      return () => {
        gate = null
        release()
      }
    },
  }
}

describe('ActivityStore 轮询', () => {
  test('启用时读一次；空闲（没有运行、没有后台）读完就不再安排下一次', async () => {
    const h = harness()
    h.store.configure(config())
    await settle()
    expect(h.calls).toHaveLength(1)
    expect(h.timers.pending).toBe(0)
    await h.timers.advance(60_000)
    expect(h.calls).toHaveLength(1)
    expect(h.store.getSnapshot().loaded).toBe(true)
  })

  test('运行中按间隔轮询，这一轮结束后停下', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true }))
    await settle()
    await h.timers.advance(ACTIVE_POLL_MS * 3)
    expect(h.calls).toHaveLength(4)
    h.store.configure(config({ turnActive: false }))
    await settle()
    // 结束的那一刻补读一次拿最终状态，之后不再轮询。
    const after = h.calls.length
    await h.timers.advance(60_000)
    expect(h.calls).toHaveLength(after)
  })

  test('页面不可见时暂停并取消待发的轮询；回到前台立刻补读并恢复', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true }))
    await settle()
    expect(h.timers.pending).toBe(1)
    h.store.configure(config({ turnActive: true, visible: false }))
    expect(h.timers.pending).toBe(0)
    const paused = h.calls.length
    await h.timers.advance(60_000)
    expect(h.calls).toHaveLength(paused)
    h.store.configure(config({ turnActive: true, visible: true }))
    await settle()
    expect(h.calls).toHaveLength(paused + 1)
    expect(h.timers.pending).toBe(1)
  })

  test('后台任务 id 增减立刻重读；有后台任务就持续轮询，清空后停', async () => {
    const h = harness({ background: [bg({})] })
    h.store.configure(config({ backgroundKey: 't' }))
    await settle()
    expect(h.calls).toHaveLength(1)
    expect(h.timers.pending).toBe(1)
    h.set({ background: [bg({ status: 'completed' })] })
    h.store.configure(config({ backgroundKey: '' }))
    await settle()
    expect(h.calls).toHaveLength(2)
    expect(h.timers.pending).toBe(0)
  })

  test('读取进行中又来配置变化：合并成一次补读，不并发', async () => {
    const h = harness()
    const release = h.hold()
    h.store.configure(config({ turnActive: true }))
    h.store.configure(config({ turnActive: true, backgroundKey: 'x' }))
    h.store.configure(config({ turnActive: true, backgroundKey: 'x\ny' }))
    await settle()
    expect(h.calls).toHaveLength(1)
    release()
    await settle()
    expect(h.calls).toHaveLength(2)
  })

  test('禁用后取消进行中的读取，晚到的结果不写入', async () => {
    const h = harness({ tasks: [info({})] })
    const release = h.hold()
    h.store.configure(config({ turnActive: true }))
    await settle()
    h.store.configure(config({ enabled: false }))
    release()
    await settle()
    expect(h.store.getSnapshot().loaded).toBe(false)
    expect(h.timers.pending).toBe(0)
    // 之后重新启用不会被旧请求的收尾状态卡住。
    h.store.configure(config({ turnActive: true }))
    await settle()
    expect(h.store.getSnapshot().tasks).toHaveLength(1)
  })

  test('没有团队（null）后隔一段时间才再探测；手动刷新立刻探测', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true }))
    await settle()
    expect(h.calls[0]?.team).toBe(true)
    await h.timers.advance(ACTIVE_POLL_MS)
    expect(h.calls[1]?.team).toBe(false)
    await h.timers.advance(TEAM_RECHECK_MS)
    expect(h.calls.some((call, index) => index > 1 && call.team)).toBe(true)
    const before = h.calls.length
    await h.store.refresh({ forceTeam: true })
    expect(h.calls[before]?.team).toBe(true)
  })

  test('团队方案状态一变（刚确认）就连团队一起重读，不等团队探测的间隔', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true, teamPlanKey: 'p1:review_pending' }))
    await settle()
    await h.timers.advance(ACTIVE_POLL_MS)
    expect(h.calls.at(-1)?.team).toBe(false)
    const before = h.calls.length
    h.store.configure(config({ turnActive: true, teamPlanKey: 'p1:launching', teamLaunching: true }))
    await settle()
    expect(h.calls).toHaveLength(before + 1)
    expect(h.calls.at(-1)?.team).toBe(true)
  })

  test('团队启动中：队长空闲也按间隔轮询，每次都读团队；就位后照常', async () => {
    const h = harness()
    h.store.configure(config({ teamPlanKey: 'p1:launching', teamLaunching: true }))
    await settle()
    await h.timers.advance(ACTIVE_POLL_MS * 2)
    expect(h.calls).toHaveLength(3)
    expect(h.calls.every((call) => call.team)).toBe(true)
    h.set({ team: timeline([member({ activity: 'active' })]) })
    h.store.configure(config({ teamPlanKey: 'p1:running' }))
    await settle()
    expect(h.store.getSnapshot().team).not.toBeNull()
    expect(h.timers.pending).toBe(1)
  })

  test('页面不可见时方案变了：回到前台的那次补读带上团队', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true, teamPlanKey: 'p1:review_pending' }))
    await settle()
    await h.timers.advance(ACTIVE_POLL_MS)
    h.store.configure(config({ turnActive: true, visible: false, teamPlanKey: 'p1:running' }))
    const before = h.calls.length
    h.store.configure(config({ turnActive: true, teamPlanKey: 'p1:running' }))
    await settle()
    expect(h.calls).toHaveLength(before + 1)
    expect(h.calls.at(-1)?.team).toBe(true)
  })

  test('团队存在就每次都读；一部分失败时保留旧数据并报告', async () => {
    const h = harness({ team: timeline([member({ activity: 'active' })]), tasks: [info({ subject: '旧任务' })] })
    h.store.configure(config())
    await settle()
    expect(h.timers.pending).toBe(1) // 团队有人工作中，空闲也轮询
    h.set({ errors: ['任务：断网'], tasks: undefined })
    await h.timers.advance(ACTIVE_POLL_MS)
    expect(h.calls.every((call) => call.team)).toBe(true)
    const snapshot = h.store.getSnapshot()
    expect(snapshot.tasks[0]?.subject).toBe('旧任务')
    expect(snapshot.error).toBe('任务：断网')
  })

  test('整体读取失败：记录原因、标记 loaded，不抛出', async () => {
    const timers = new FakeTimers()
    const store = new ActivityStore({
      fetch: async () => {
        throw new Error('电脑不可达')
      },
      send: () => true,
      timers,
    })
    store.configure(config())
    await settle()
    expect(store.getSnapshot()).toMatchObject({ loaded: true, error: '电脑不可达' })
  })
})

describe('ActivityStore 重新启用', () => {
  test('被取消的旧读取收尾时，不会把新读取当成已结束', async () => {
    const timers = new FakeTimers()
    const gates: (() => void)[] = []
    let calls = 0
    const store = new ActivityStore({
      fetch: async () => {
        calls++
        await new Promise<void>((resolve) => gates.push(resolve))
        return { errors: [], tasks: [], team: null, background: [] }
      },
      send: () => true,
      timers,
    })
    store.configure(config({ turnActive: true }))
    await settle()
    store.configure(config({ enabled: false }))
    store.configure(config({ turnActive: true })) // 第二次读取开始，旧的还没返回
    await settle()
    expect(calls).toBe(2)
    gates[0]!() // 旧读取收尾
    await settle()
    store.configure(config({ turnActive: true, backgroundKey: 'x' })) // 新读取仍在进行：只能合并，不能并发
    await settle()
    expect(calls).toBe(2)
    gates[1]!()
    await settle()
    expect(calls).toBe(3)
  })
})

describe('ActivityStore 停止', () => {
  const running = () => [agent({}), bg({ taskId: 'c1' }), bg({ taskId: 'c2', status: 'completed' })]
  async function ready() {
    const h = harness({ background: running() })
    h.store.configure(config({ backgroundKey: 'a1\nc1' }))
    await settle()
    return h
  }
  test('单项停止发出 stop_background_task，并标记停止中', async () => {
    const h = await ready()
    expect(h.store.stopTask('c1')).toBe(true)
    expect(h.sent).toEqual([{ type: 'stop_background_task', taskId: 'c1' }])
    expect(h.store.getSnapshot().stopping).toEqual({ c1: true })
    expect(h.store.stopTask('c1')).toBe(true)
    expect(h.sent).toHaveLength(1) // 重复点击不重复发
  })
  test('全部停止只发给仍在运行的子 Agent 和命令', async () => {
    const h = await ready()
    h.store.stopAll()
    expect(h.sent.map((message) => (message as { taskId: string }).taskId).sort()).toEqual(['a1', 'c1'])
  })
  test('已经不在运行的任务不能被停止', async () => {
    const h = await ready()
    h.store.stopTask('c2')
    h.store.stopTask('ghost')
    expect(h.sent).toEqual([])
  })
  test('连接没就绪：不标记停止中，给出明确提示', async () => {
    const timers = new FakeTimers()
    const store = new ActivityStore({
      fetch: async () => ({ errors: [], background: [bg({})] }),
      send: () => false,
      timers,
    })
    store.configure(config())
    await settle()
    expect(store.stopTask('t')).toBe(false)
    expect(store.getSnapshot().stopping).toEqual({})
    expect(store.getSnapshot().stopError).toContain('连接已断开')
  })
  test('页面传入的发送函数优先于默认的', async () => {
    const h = await ready()
    const own: ClientMessage[] = []
    h.store.setSender((message) => (own.push(message), true))
    h.store.stopTask('c1')
    expect(own).toHaveLength(1)
    expect(h.sent).toHaveLength(0)
  })
  test('电脑一直不回：超时后解除停止中并提示；任务如期结束则不提示', async () => {
    const h = await ready()
    h.store.stopTask('c1')
    await h.timers.advance(STOP_TIMEOUT_MS)
    expect(h.store.getSnapshot().stopping).toEqual({})
    expect(h.store.getSnapshot().stopError).toContain('没有回应')

    const ok = await ready()
    ok.store.stopTask('c1')
    ok.set({ background: [agent({}), bg({ taskId: 'c1', status: 'stopped' })] })
    await ok.store.refresh()
    expect(ok.store.getSnapshot().stopping).toEqual({})
    await ok.timers.advance(STOP_TIMEOUT_MS)
    expect(ok.store.getSnapshot().stopError).toBe('')
  })
  test('任务全部停下后，停止失败的旧提示一并清掉', async () => {
    const h = await ready()
    h.store.stopTask('c1')
    await h.timers.advance(STOP_TIMEOUT_MS)
    h.set({ background: [agent({ status: 'stopped' }), bg({ taskId: 'c1', status: 'stopped' })] })
    await h.store.refresh()
    expect(h.store.getSnapshot().stopError).toBe('')
  })
})

describe('createActivityFetcher', () => {
  const fixture = (routes: Record<string, { status?: number; body: unknown }>) => {
    const paths: string[] = []
    const api = new ApiClient({ id: 'fixture', name: '', url: 'http://127.0.0.1:3457', auth: 'lan' }, 'fixture', {
      fetch: async (url) => {
        const path = new URL(url).pathname
        paths.push(path)
        const route = routes[path]
        const status = route ? (route.status ?? 200) : 404
        return { ok: status === 200, status, redirected: false, url, text: async () => JSON.stringify(route?.body ?? {}) }
      },
    })
    return { api, paths }
  }
  const routes = {
    '/api/tasks/lists/s%2F1': { body: { tasks: [info({ subject: 'x' })] } },
    '/api/sessions/s%2F1/background-tasks': { body: { tasks: [bg({})], historyComplete: true } },
  }
  test('一处读三份：任务、团队（404 = 没有团队）、后台任务', async () => {
    const { api, paths } = fixture(routes)
    const result = await createActivityFetcher(api, 's/1')(new AbortController().signal, { team: true })
    expect(result.tasks).toHaveLength(1)
    expect(result.team).toBeNull()
    expect(result.background).toHaveLength(1)
    expect(result.errors).toEqual([])
    expect(paths).toHaveLength(3)
  })
  test('不需要团队时不发团队请求', async () => {
    const { api, paths } = fixture(routes)
    const result = await createActivityFetcher(api, 's/1')(new AbortController().signal, { team: false })
    expect(result.team).toBeUndefined()
    expect(paths.some((path) => path.includes('/teams/'))).toBe(false)
  })
  test('某一份失败：其余照常返回，失败原因进 errors', async () => {
    const { api } = fixture({ ...routes, '/api/tasks/lists/s%2F1': { status: 500, body: { error: 'boom' } } })
    const result = await createActivityFetcher(api, 's/1')(new AbortController().signal, { team: false })
    expect(result.tasks).toBeUndefined()
    expect(result.background).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toStartWith('任务：')
  })
})
