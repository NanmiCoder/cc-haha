import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessionRunsMock = vi.hoisted(() => vi.fn())
vi.mock('../api/workflows', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/workflows')>()
  return {
    ...actual,
    workflowsApi: { ...actual.workflowsApi, sessionRuns: sessionRunsMock },
  }
})
import {
  activeRunForSession,
  groupRunPhases,
  runCompletion,
  runsForOwner,
  runsForSession,
  useWorkflowStore,
  workflowRunIdentity,
} from './workflowStore'
import type { ReconstructedWorkflowRun } from '../types/workflow'

const SESSION = 'session-1'
const TASK = 'w1234abcd'

function taskStarted(overrides: Record<string, unknown> = {}) {
  return {
    task_id: TASK,
    task_type: 'local_workflow',
    workflow_name: 'audit-routes',
    description: 'Audit every route handler',
    ...overrides,
  }
}

function progress(
  rows: Array<Record<string, unknown>>,
  usage?: { total_tokens?: number; tool_uses?: number },
) {
  return {
    task_id: TASK,
    workflow_progress: rows,
    ...(usage ? { usage } : {}),
  }
}

function agentRow(
  index: number,
  state: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'workflow_agent',
    index,
    label: `agent ${index}`,
    state,
    ...extra,
  }
}

describe('workflowStore', () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      runs: {},
      definitions: [],
      definitionsLoading: false,
      definitionsError: null,
      history: [],
      historyLoading: false,
      openRunId: null,
    })
  })

  const store = () => useWorkflowStore.getState()
  const rootRun = () => useWorkflowStore.getState().runs[
    workflowRunIdentity(SESSION, undefined, TASK)
  ]

  it('creates a run from task_started and tracks it for the session', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    const runs = runsForSession(useWorkflowStore.getState(), SESSION)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      taskId: TASK,
      workflowName: 'audit-routes',
      description: 'Audit every route handler',
      status: 'running',
    })
    expect(activeRunForSession(useWorkflowStore.getState(), SESSION)?.taskId).toBe(
      TASK,
    )
  })

  it('replaces a running task when the same workflow run resumes before its terminal arrives', () => {
    const runId = 'wf_resumed-run-1'
    store().handleTaskEvent(SESSION, 'task_started', taskStarted({
      workflow_run_id: runId,
    }))
    store().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([
        { type: 'workflow_phase', index: 1, title: 'Map' },
        agentRow(1, 'done', { phaseIndex: 1, phaseTitle: 'Map' }),
      ]),
    )
    store().openRun(TASK)

    const resumedTaskId = 'w-resumed'
    store().handleTaskEvent(SESSION, 'task_started', taskStarted({
      task_id: resumedTaskId,
      workflow_run_id: runId,
    }))
    store().handleTaskEvent(SESSION, 'task_progress', {
      ...progress([
        { type: 'workflow_phase', index: 2, title: 'Verify' },
        agentRow(1, 'progress', { phaseIndex: 2, phaseTitle: 'Verify' }),
      ]),
      task_id: resumedTaskId,
      workflow_run_id: runId,
    })
    store().handleTaskEvent(SESSION, 'task_notification', {
      task_id: TASK,
      workflow_run_id: runId,
      status: 'completed',
      summary: 'Late terminal event for the original task',
    })

    const runs = runsForSession(useWorkflowStore.getState(), SESSION)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      taskId: resumedTaskId,
      runId,
      status: 'running',
    })
    expect(useWorkflowStore.getState().openRunId).toBe(resumedTaskId)
    expect(groupRunPhases(runs[0]!).phases.map(phase => phase.title)).toEqual([
      'Verify',
    ])
  })

  it('keeps independent runs that share a workflow name', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted({
      task_id: 'w-first',
      workflow_run_id: 'wf_first',
    }))
    store().handleTaskEvent(SESSION, 'task_started', taskStarted({
      task_id: 'w-second',
      workflow_run_id: 'wf_second',
    }))

    expect(
      runsForSession(useWorkflowStore.getState(), SESSION).map(run => run.taskId),
    ).toEqual(expect.arrayContaining(['w-first', 'w-second']))
  })

  it('still ignores a bare notification for a task it never tracked', () => {
    store().handleTaskEvent(SESSION, 'task_notification', {
      task_id: 'b0000009',
      status: 'completed',
    })
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(0)
  })

  it('ignores task events that are not workflows', () => {
    store().handleTaskEvent(SESSION, 'task_started', {
      task_id: 'b0000001',
      task_type: 'local_bash',
      description: 'npm test',
    })
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(0)
  })

  it('replaces an agent row in place instead of appending a new one', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([agentRow(1, 'progress', { tokens: 100 })]),
    )
    store().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([agentRow(1, 'done', { tokens: 400 })]),
    )

    const run = rootRun()!
    const agents = run.progress.filter(row => row.type === 'workflow_agent')
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ index: 1, state: 'done', tokens: 400 })
    expect(run.agentCount).toBe(1)
  })

  it('keeps the object identity stable when an event changes nothing', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    const before = rootRun()
    store().handleTaskEvent(SESSION, 'task_progress', progress([]))
    expect(rootRun()).toBe(before)
  })

  it('carries usage totals from the event', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([agentRow(1, 'done')], { total_tokens: 1234, tool_uses: 7 }),
    )
    expect(rootRun()).toMatchObject({
      totalTokens: 1234,
      toolCalls: 7,
    })
  })

  it('settles the run on task_notification and records the result', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    // The CLI's terminal notification carries no task_type / workflow_name /
    // workflow_progress — only the task id. Dropping it here is what left the
    // dock reading "1 running" after a finished run.
    store().handleTaskEvent(SESSION, 'task_notification', {
      task_id: TASK,
      status: 'completed',
      result: '["ALPHA","BETA"]',
      summary: 'Dynamic workflow "route-survey" completed',
    })
    const run = rootRun()!
    expect(run.status).toBe('completed')
    expect(run.result).toBe('["ALPHA","BETA"]')
    expect(run.endedAt).toBeGreaterThan(0)
    expect(activeRunForSession(useWorkflowStore.getState(), SESSION)).toBeNull()
  })

  it('a late progress event does not revive a settled run', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(SESSION, 'task_notification', {
      task_id: TASK,
      status: 'failed',
      error: 'boom',
    })
    store().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([agentRow(2, 'progress')]),
    )
    const run = rootRun()!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('boom')
  })

  it('surfaces a failure reason that only arrived in the summary', () => {
    // Seen on a real failed run: the CLI's terminal event has no `error`
    // field, so the reason only ever comes through `summary`. Reading it as
    // the description put it in a truncated one-liner and left the error
    // banner empty — a red "failed" badge with no explanation.
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(SESSION, 'task_notification', {
      task_id: TASK,
      status: 'failed',
      summary:
        'Dynamic workflow "audit-routes" failed: deliberate failure after the probe settled',
    })
    const run = rootRun()!
    expect(run.error).toContain('deliberate failure after the probe settled')
    // The run's own description must survive the notification.
    expect(run.description).toBe('Audit every route handler')
  })

  it('keeps the description when a run completes', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(SESSION, 'task_notification', {
      task_id: TASK,
      status: 'completed',
      summary: 'Dynamic workflow "audit-routes" completed',
      result: '{}',
    })
    const run = rootRun()!
    expect(run.description).toBe('Audit every route handler')
    // Boilerplate completion text is not an error.
    expect(run.error).toBeUndefined()
  })

  it('maps a killed CLI status onto stopped', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(SESSION, 'task_notification', {
      task_id: TASK,
      status: 'killed',
    })
    expect(rootRun()?.status).toBe('stopped')
  })

  it('clearSession drops only that session and closes an open run', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent('other', 'task_started', taskStarted({ task_id: 'w9' }))
    store().openRun(TASK)

    store().clearSession(SESSION)
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(0)
    expect(runsForSession(useWorkflowStore.getState(), 'other')).toHaveLength(1)
    expect(useWorkflowStore.getState().openRunId).toBeNull()
  })

  it('groups agents under the phase they reported', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([
        { type: 'workflow_phase', index: 1, title: 'Review', kind: 'meta' },
        { type: 'workflow_phase', index: 2, title: 'Verify', kind: 'script' },
        agentRow(1, 'done', { phaseIndex: 1, phaseTitle: 'Review' }),
        agentRow(2, 'progress', { phaseIndex: 2, phaseTitle: 'Verify' }),
        agentRow(3, 'done'),
      ]),
    )
    const run = rootRun()!
    const { phases, ungrouped } = groupRunPhases(run)
    expect(phases.map(phase => phase.title)).toEqual(['Review', 'Verify'])
    expect(phases[0]?.agents.map(agent => agent.index)).toEqual([1])
    expect(phases[1]?.agents.map(agent => agent.index)).toEqual([2])
    expect(ungrouped.map(agent => agent.index)).toEqual([3])
  })

  it('reports completion as the settled fraction of agents', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([
        agentRow(1, 'done'),
        agentRow(2, 'error'),
        agentRow(3, 'progress'),
        agentRow(4, 'start'),
      ]),
    )
    expect(runCompletion(rootRun()!)).toBe(0.5)
  })

  it('recognises a workflow from workflow_progress even without task_type', () => {
    store().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([agentRow(1, 'progress')]),
    )
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(1)
  })

  it('does not collide identical task ids across sessions and transcript owners', () => {
    store().handleTaskEvent(SESSION, 'task_started', taskStarted())
    store().handleTaskEvent(SESSION, 'task_started', taskStarted({
      owner_agent_id: 'owner-a',
    }))
    store().handleTaskEvent('session-2', 'task_started', taskStarted())

    expect(Object.keys(useWorkflowStore.getState().runs)).toHaveLength(3)
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(1)
    expect(runsForOwner(useWorkflowStore.getState(), SESSION, ['owner-a'])).toHaveLength(1)
  })
})

describe('hydrateSession', () => {
  const RECONSTRUCTED = {
    runId: 'wf_06ee51bf-6b1',
    taskId: 'w-history-1',
    workflowName: 'review-last-month',
    status: 'completed' as const,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    endedAt: 1_700_000_000_500,
    agents: [
      { agentId: 'a1', label: 'review:imagegen', phaseIndex: 1, phaseTitle: 'Dimension review', agentIndex: 1, state: 'done' as const },
      { agentId: 'a2', label: 'review:security', phaseIndex: 1, phaseTitle: 'Dimension review', agentIndex: 2, state: 'done' as const },
      { agentId: 'a3', label: 'verify:security', phaseIndex: 2, phaseTitle: 'Adversarial verification', agentIndex: 3, state: 'done' as const },
    ],
  }

  beforeEach(() => {
    sessionRunsMock.mockReset()
    useWorkflowStore.setState({ runs: {}, openRunId: null })
  })

  it('rebuilds a finished run so a reopened session still shows it', async () => {
    // The whole point: the live progress stream is gone by now.
    sessionRunsMock.mockResolvedValue({ runs: [RECONSTRUCTED] })
    await useWorkflowStore.getState().hydrateSession(SESSION)

    const runs = runsForSession(useWorkflowStore.getState(), SESSION)
    expect(runs).toHaveLength(1)
    const { phases } = groupRunPhases(runs[0]!)
    expect(phases.map(phase => phase.title)).toEqual(['Dimension review', 'Adversarial verification'])
    expect(phases[0]!.agents.map(agent => agent.label)).toEqual([
      'review:imagegen',
      'review:security',
    ])
    // Every reconstructed agent has a transcript, so it is openable.
    expect(phases[0]!.agents.every(agent => agent.agentId)).toBe(true)
  })

  it('restores the authoritative latest progress snapshot with cached flags', async () => {
    sessionRunsMock.mockResolvedValue({
      runs: [{
        ...RECONSTRUCTED,
        progress: [
          { type: 'workflow_phase', index: 1, title: 'Run' },
          {
            type: 'workflow_agent',
            index: 1,
            label: 'A',
            state: 'done',
            phaseIndex: 1,
            phaseTitle: 'Run',
            agentId: 'a1',
            cached: true,
          },
          {
            type: 'workflow_agent',
            index: 2,
            label: 'X',
            state: 'done',
            phaseIndex: 1,
            phaseTitle: 'Run',
            agentId: 'x1',
          },
        ],
      }],
    })

    await useWorkflowStore.getState().hydrateSession(SESSION)
    await useWorkflowStore.getState().hydrateSession(SESSION)

    const [run] = runsForSession(useWorkflowStore.getState(), SESSION)
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(1)
    const agents = run!.progress.filter(row => row.type === 'workflow_agent')
    expect(agents).toHaveLength(2)
    expect(agents.map(agent => [agent.label, agent.cached === true])).toEqual([
      ['A', true],
      ['X', false],
    ])
  })

  it('advances reconstructed lifecycle without dropping the cached snapshot', async () => {
    const durableProgress: ReconstructedWorkflowRun['progress'] = [
      { type: 'workflow_phase', index: 1, title: 'Run' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'A',
        state: 'done',
        phaseIndex: 1,
        agentId: 'a1',
        cached: true,
      },
    ]
    sessionRunsMock
      .mockResolvedValueOnce({
        runs: [{
          ...RECONSTRUCTED,
          status: 'running',
          updatedAt: RECONSTRUCTED.startedAt,
          endedAt: undefined,
          progress: durableProgress,
        }],
      })
      .mockResolvedValueOnce({
        runs: [{
          ...RECONSTRUCTED,
          status: 'failed',
          updatedAt: RECONSTRUCTED.updatedAt + 500,
          endedAt: RECONSTRUCTED.updatedAt + 500,
          error: 'verification failed',
          progress: durableProgress,
        }],
      })

    await useWorkflowStore.getState().hydrateSession(SESSION)
    const before = runsForSession(useWorkflowStore.getState(), SESSION)[0]!
    await useWorkflowStore.getState().hydrateSession(SESSION)
    const after = runsForSession(useWorkflowStore.getState(), SESSION)[0]!

    expect(after).not.toBe(before)
    expect(after).toMatchObject({
      status: 'failed',
      error: 'verification failed',
      endedAt: RECONSTRUCTED.updatedAt + 500,
    })
    expect(after.progress).toContainEqual(expect.objectContaining({
      type: 'workflow_agent',
      label: 'A',
      cached: true,
    }))
  })

  it('upgrades a sidecar fallback when a later hydrate finds task progress', async () => {
    const authoritative = {
      ...RECONSTRUCTED,
      progress: [
        { type: 'workflow_phase' as const, index: 1, title: 'Run' },
        {
          type: 'workflow_agent' as const,
          index: 1,
          label: 'A',
          state: 'done' as const,
          phaseIndex: 1,
          phaseTitle: 'Run',
          agentId: 'a1',
          cached: true,
        },
        {
          type: 'workflow_agent' as const,
          index: 2,
          label: 'X',
          state: 'done' as const,
          phaseIndex: 1,
          phaseTitle: 'Run',
          agentId: 'x1',
        },
      ],
    }
    sessionRunsMock
      .mockResolvedValue({ runs: [authoritative] })
      .mockResolvedValueOnce({ runs: [RECONSTRUCTED] })

    await useWorkflowStore.getState().hydrateSession(SESSION)
    expect(
      runsForSession(useWorkflowStore.getState(), SESSION)[0]!.progress
        .filter(row => row.type === 'workflow_agent')
        .map(row => row.label),
    ).toEqual(['review:imagegen', 'review:security', 'verify:security'])

    await useWorkflowStore.getState().hydrateSession(SESSION)
    const upgraded = runsForSession(useWorkflowStore.getState(), SESSION)[0]!
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(1)
    expect(
      upgraded.progress
        .filter(row => row.type === 'workflow_agent')
        .map(row => [row.label, row.cached === true]),
    ).toEqual([
      ['A', true],
      ['X', false],
    ])

    await useWorkflowStore.getState().hydrateSession(SESSION)
    expect(runsForSession(useWorkflowStore.getState(), SESSION)[0]).toBe(upgraded)
  })

  it('replaces the old reconstructed task key when the same run resumes', async () => {
    const resumedTaskId = 'w-history-resumed'
    sessionRunsMock
      .mockResolvedValueOnce({ runs: [RECONSTRUCTED] })
      .mockResolvedValueOnce({
        runs: [{
          ...RECONSTRUCTED,
          taskId: resumedTaskId,
          updatedAt: RECONSTRUCTED.updatedAt + 1_000,
          endedAt: RECONSTRUCTED.updatedAt + 1_000,
          progress: [{
            type: 'workflow_agent',
            index: 1,
            label: 'resumed probe',
            state: 'done',
            agentId: 'resumed-agent',
          }],
        }],
      })

    await useWorkflowStore.getState().hydrateSession(SESSION)
    useWorkflowStore.getState().openRun(RECONSTRUCTED.taskId)
    await useWorkflowStore.getState().hydrateSession(SESSION)

    const runs = runsForSession(useWorkflowStore.getState(), SESSION)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      runId: RECONSTRUCTED.runId,
      taskId: resumedTaskId,
    })
    expect(runs[0]!.progress).toContainEqual(expect.objectContaining({
      label: 'resumed probe',
    }))
    expect(useWorkflowStore.getState().openRunId).toBe(resumedTaskId)
    expect(Object.keys(useWorkflowStore.getState().runs)).toEqual([
      workflowRunIdentity(SESSION, undefined, resumedTaskId),
    ])
  })

  it('ignores an older hydrate response that arrives after a newer snapshot', async () => {
    const authoritative: ReconstructedWorkflowRun = {
      ...RECONSTRUCTED,
      progress: [
        { type: 'workflow_phase', index: 1, title: 'Run' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'A',
          state: 'done',
          phaseIndex: 1,
          phaseTitle: 'Run',
          agentId: 'a1',
          cached: true,
        },
        {
          type: 'workflow_agent',
          index: 2,
          label: 'X',
          state: 'done',
          phaseIndex: 1,
          phaseTitle: 'Run',
          agentId: 'x1',
        },
      ],
    }
    const resolvers: Array<(
      value: { runs: ReconstructedWorkflowRun[] },
    ) => void> = []
    sessionRunsMock.mockImplementation(
      () => new Promise<{ runs: ReconstructedWorkflowRun[] }>(resolve => {
        resolvers.push(resolve)
      }),
    )

    const olderHydrate = useWorkflowStore.getState().hydrateSession(SESSION)
    const newerHydrate = useWorkflowStore.getState().hydrateSession(SESSION)
    resolvers[1]!({ runs: [authoritative] })
    await newerHydrate
    resolvers[0]!({ runs: [RECONSTRUCTED] })
    await olderHydrate

    const runs = runsForSession(useWorkflowStore.getState(), SESSION)
    expect(runs).toHaveLength(1)
    expect(
      runs[0]!.progress
        .filter(row => row.type === 'workflow_agent')
        .map(row => [row.label, row.cached === true]),
    ).toEqual([
      ['A', true],
      ['X', false],
    ])
  })

  it('leaves an unrecorded phase title empty rather than inventing one', () => {
    // The renderer falls back to the run name; filling in "Phase 0" here made
    // that impossible and showed a meaningless heading.
    sessionRunsMock.mockResolvedValue({
      runs: [{
        ...RECONSTRUCTED,
        agents: [{ agentId: 'a1', label: 'review:security', phaseIndex: 0, agentIndex: 1, state: 'done' }],
      }],
    })
    return useWorkflowStore.getState().hydrateSession(SESSION).then(() => {
      const run = runsForSession(useWorkflowStore.getState(), SESSION)[0]!
      const phase = run.progress.find((row) => row.type === 'workflow_phase')!
      expect(phase.title).toBe('')
    })
  })

  it('never overwrites a run that is still streaming live', async () => {
    useWorkflowStore.getState().handleTaskEvent(SESSION, 'task_started', {
      task_id: TASK,
      task_type: 'local_workflow',
      workflow_name: 'review-last-month',
      workflow_run_id: RECONSTRUCTED.runId,
    })
    useWorkflowStore.getState().handleTaskEvent(
      SESSION,
      'task_progress',
      progress([agentRow(1, 'progress')]),
    )
    sessionRunsMock.mockResolvedValue({ runs: [RECONSTRUCTED] })

    await useWorkflowStore.getState().hydrateSession(SESSION)

    const runs = runsForSession(useWorkflowStore.getState(), SESSION)
    // One run, still the live one — a reconstruction would have marked its
    // in-flight agent as done.
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('running')
    expect(runs[0]!.taskId).toBe(TASK)
  })

  it('stays quiet when the server cannot rebuild anything', async () => {
    sessionRunsMock.mockRejectedValue(new Error('offline'))
    await useWorkflowStore.getState().hydrateSession(SESSION)
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(0)
  })

  it('hydrates owned failures only into the matching synthetic agent session', async () => {
    sessionRunsMock.mockResolvedValue({
      runs: [
        RECONSTRUCTED,
        {
          ...RECONSTRUCTED,
          runId: 'wf_owned-failed',
          taskId: 'w-owned-failed',
          ownerAgentId: 'owner-fragment-a',
          status: 'failed',
          error: 'probe failed',
          agents: [{
            agentId: 'owned-worker',
            label: 'owned worker',
            phaseIndex: 1,
            agentIndex: 1,
            state: 'error',
            error: 'probe failed',
          }],
        },
      ],
    })

    await useWorkflowStore.getState().hydrateSession(SESSION)
    expect(runsForSession(useWorkflowStore.getState(), SESSION)).toHaveLength(1)
    expect(runsForOwner(useWorkflowStore.getState(), SESSION, ['owner-fragment-a'])).toHaveLength(0)

    await useWorkflowStore.getState().hydrateOwnerSession(
      SESSION,
      ['owner-fragment-a'],
      'subagent:synthetic',
    )
    const owned = runsForOwner(
      useWorkflowStore.getState(),
      SESSION,
      ['owner-fragment-a'],
    )
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({
      sessionId: 'subagent:synthetic',
      sourceSessionId: SESSION,
      ownerAgentId: 'owner-fragment-a',
      status: 'failed',
      error: 'probe failed',
    })
    expect(owned[0]?.progress).toContainEqual(expect.objectContaining({
      agentId: 'owned-worker',
      state: 'error',
    }))
  })

  it('ignores an older owner hydrate response after a newer cached terminal', async () => {
    const ownerAgentId = 'owner-fragment-a'
    const targetSessionId = 'subagent:synthetic'
    const resolvers: Array<(
      value: { runs: ReconstructedWorkflowRun[] },
    ) => void> = []
    sessionRunsMock.mockImplementation(
      () => new Promise<{ runs: ReconstructedWorkflowRun[] }>(resolve => {
        resolvers.push(resolve)
      }),
    )
    const olderHydrate = useWorkflowStore.getState().hydrateOwnerSession(
      SESSION,
      [ownerAgentId],
      targetSessionId,
    )
    const newerHydrate = useWorkflowStore.getState().hydrateOwnerSession(
      SESSION,
      [ownerAgentId],
      targetSessionId,
    )
    const ownedRun: ReconstructedWorkflowRun = {
      ...RECONSTRUCTED,
      ownerAgentId,
    }
    resolvers[1]!({
      runs: [{
        ...ownedRun,
        status: 'failed',
        updatedAt: RECONSTRUCTED.updatedAt + 500,
        endedAt: RECONSTRUCTED.updatedAt + 500,
        error: 'newer terminal',
        progress: [{
          type: 'workflow_agent',
          index: 1,
          label: 'cached owner probe',
          state: 'done',
          agentId: 'owned-worker',
          cached: true,
        }],
      }],
    })
    await newerHydrate
    resolvers[0]!({ runs: [ownedRun] })
    await olderHydrate

    const owned = runsForOwner(
      useWorkflowStore.getState(),
      SESSION,
      [ownerAgentId],
    )
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({
      sessionId: targetSessionId,
      status: 'failed',
      error: 'newer terminal',
    })
    expect(owned[0]!.progress).toContainEqual(expect.objectContaining({
      label: 'cached owner probe',
      cached: true,
    }))
  })

  it('invalidates an in-flight owner hydrate when its target session clears', async () => {
    const targetSessionId = 'subagent:cleared'
    let resolveHydrate: ((value: { runs: ReconstructedWorkflowRun[] }) => void) | undefined
    sessionRunsMock.mockImplementation(
      () => new Promise<{ runs: ReconstructedWorkflowRun[] }>(resolve => {
        resolveHydrate = resolve
      }),
    )

    const pending = useWorkflowStore.getState().hydrateOwnerSession(
      SESSION,
      ['owner-fragment-a'],
      targetSessionId,
    )
    useWorkflowStore.getState().clearSession(targetSessionId)
    resolveHydrate!({
      runs: [{ ...RECONSTRUCTED, ownerAgentId: 'owner-fragment-a' }],
    })
    await pending

    expect(Object.values(useWorkflowStore.getState().runs)).toHaveLength(0)
  })

  it('can remap an independent member session root run into its synthetic tab', async () => {
    sessionRunsMock.mockResolvedValue({ runs: [RECONSTRUCTED] })

    await useWorkflowStore.getState().hydrateOwnerSession(
      'independent-member-session',
      ['member-agent'],
      'team-member:synthetic',
      { includeRoot: true },
    )

    const run = Object.values(useWorkflowStore.getState().runs)[0]
    expect(run).toMatchObject({
      sourceSessionId: 'independent-member-session',
      sessionId: 'team-member:synthetic',
      status: 'completed',
    })
    expect(run?.ownerAgentId).toBeUndefined()
  })
})
