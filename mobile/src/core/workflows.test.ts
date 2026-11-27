import { describe, expect, test } from 'bun:test'
import { ApiClient } from './client'
import { chatReducer, createChatState } from './chat'
import type { BackgroundTask } from './operations'
import type { ServerEvent } from './types'
import {
  buildWorkflowActivityRuns,
  buildWorkflowHistoryRuns,
  hasActiveLiveWorkflow,
  isAgentIdRef,
  loadSessionWorkflowRuns,
  loadSessionWorkflowRunsSafe,
  loadWorkflowRunDetail,
  pruneInactiveRunningWorkflows,
  readAgentIdRef,
  reduceWorkflowRuns,
  toAgentIdRef,
  workflowAgentStatusText,
  workflowRunStatusText,
  type ReconstructedWorkflowRun,
  type WorkflowLiveRun,
} from './workflows'

describe('agent id ref helpers', () => {
  test('round-trips valid agent ids and rejects empty or slash-containing refs', () => {
    const ref = toAgentIdRef('agent-abc_1')
    expect(ref).toBe('agent:agent-abc_1')
    expect(isAgentIdRef(ref)).toBe(true)
    expect(readAgentIdRef(ref)).toBe('agent-abc_1')
    expect(isAgentIdRef('toolu_123')).toBe(false)
    expect(isAgentIdRef('agent:')).toBe(false)
    expect(isAgentIdRef('agent:a/b')).toBe(false)
  })
})

describe('reduceWorkflowRuns & chatReducer', () => {
  test('tracks live workflow phases, agents, resume replacement, and terminal state', () => {
    let clock = 1000
    const now = () => clock

    const started: ServerEvent = {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'wf-task-1',
        task_type: 'local_workflow',
        workflow_name: 'feature-flow',
        workflow_run_id: 'wf_run001',
        workflow_progress: [
          { type: 'workflow_phase', index: 1, title: '调研' },
          { type: 'workflow_phase', index: 2, title: '实现' },
          { type: 'workflow_phase', index: 3, title: '验证' },
        ],
      },
    }
    let runs = reduceWorkflowRuns(undefined, started, now)
    expect(runs?.['wf-task-1']).toMatchObject({
      taskId: 'wf-task-1',
      runId: 'wf_run001',
      workflowName: 'feature-flow',
      status: 'running',
      startedAt: 1000,
    })

    // Non-workflow or child-owned task events are ignored with identical reference.
    expect(
      reduceWorkflowRuns(
        runs,
        {
          type: 'system_notification',
          subtype: 'task_started',
          data: { task_id: 'bash-1', task_type: 'local_bash' },
        },
        now
      )
    ).toBe(runs)
    expect(
      reduceWorkflowRuns(
        runs,
        {
          type: 'system_notification',
          subtype: 'task_started',
          data: {
            task_id: 'child-wf',
            owner_agent_id: 'sub-1',
            task_type: 'local_workflow',
            workflow_name: 'nested',
          },
        },
        now
      )
    ).toBe(runs)

    clock = 2000
    const progress: ServerEvent = {
      type: 'system_notification',
      subtype: 'task_progress',
      data: {
        task_id: 'wf-task-1',
        workflow_progress: [
          {
            type: 'workflow_agent',
            index: 1,
            label: '分析架构',
            state: 'progress',
            phaseIndex: 1,
            phaseTitle: '调研',
            agentId: 'ag-1',
          },
          {
            type: 'workflow_agent',
            index: 2,
            label: '查历史 PR',
            state: 'done',
            phaseIndex: 1,
            phaseTitle: '调研',
            agentId: 'ag-2',
          },
        ],
      },
    }
    runs = reduceWorkflowRuns(runs, progress, now)
    expect(runs?.['wf-task-1']?.progress).toHaveLength(5)

    // Terminal notification without task_type/workflow_name still transitions known run.
    clock = 5000
    const completed: ServerEvent = {
      type: 'system_notification',
      subtype: 'task_notification',
      data: {
        task_id: 'wf-task-1',
        status: 'completed',
        result: 'all done',
      },
    }
    runs = reduceWorkflowRuns(runs, completed, now)
    expect(runs?.['wf-task-1']).toMatchObject({
      status: 'completed',
      endedAt: 5000,
      result: 'all done',
    })

    // Late progress does not revive a terminal run.
    const afterLate = reduceWorkflowRuns(runs, progress, now)
    expect(afterLate).toBe(runs)

    // Resume reuses runId with a fresh taskId and replaces the old entry.
    clock = 6000
    const resumed: ServerEvent = {
      type: 'system_notification',
      subtype: 'task_started',
      data: {
        task_id: 'wf-task-2',
        task_type: 'local_workflow',
        workflow_name: 'feature-flow',
        workflow_run_id: 'wf_run001',
      },
    }
    runs = reduceWorkflowRuns(runs, resumed, now)
    expect(runs?.['wf-task-1']).toBeUndefined()
    expect(runs?.['wf-task-2']).toMatchObject({
      taskId: 'wf-task-2',
      runId: 'wf_run001',
      status: 'running',
    })

    // chatReducer wires workflow events into ChatState.workflows without emitting chat bubbles.
    const state = chatReducer(createChatState('s1'), started)
    expect(state.workflows?.['wf-task-1']?.workflowName).toBe('feature-flow')
    expect(state.items).toHaveLength(0)
  })

  test('normalizes killed terminal status to stopped and captures summary as error', () => {
    const started: ServerEvent = {
      type: 'system_notification',
      subtype: 'task_started',
      data: { task_id: 'wf-k', task_type: 'local_workflow', workflow_name: 'deploy' },
    }
    let runs = reduceWorkflowRuns(undefined, started, () => 100)
    runs = reduceWorkflowRuns(
      runs,
      {
        type: 'system_notification',
        subtype: 'task_notification',
        data: { task_id: 'wf-k', status: 'killed', summary: 'Stopped by user' },
      },
      () => 200
    )
    expect(runs?.['wf-k']).toMatchObject({
      status: 'stopped',
      endedAt: 200,
      error: 'Stopped by user',
    })
  })
})

describe('buildWorkflowActivityRuns', () => {
  test('groups agents by phase with all statuses, unstarted phases, and openability', () => {
    const live: Record<string, WorkflowLiveRun> = {
      'wf-1': {
        taskId: 'wf-1',
        runId: 'wf_r1',
        workflowName: 'release-flow',
        status: 'running',
        startedAt: 1000,
        updatedAt: 2000,
        progress: [
          { type: 'workflow_phase', index: 1, title: '调研' },
          { type: 'workflow_phase', index: 2, title: '实现' },
          { type: 'workflow_phase', index: 3, title: '验证' },
          {
            type: 'workflow_agent',
            index: 1,
            label: '分析接口',
            state: 'done',
            phaseIndex: 1,
            phaseTitle: '调研',
            agentId: 'ag-1',
          },
          {
            type: 'workflow_agent',
            index: 2,
            label: '扫描依赖',
            state: 'progress',
            phaseIndex: 1,
            phaseTitle: '调研',
            agentId: 'ag-2',
          },
          {
            type: 'workflow_agent',
            index: 3,
            label: '检查权限',
            state: 'error',
            phaseIndex: 1,
            phaseTitle: '调研',
            agentId: 'ag-3',
          },
          {
            type: 'workflow_agent',
            index: 4,
            label: '可选审计',
            state: 'done',
            skipped: true,
            phaseIndex: 1,
            phaseTitle: '调研',
          },
          {
            type: 'workflow_agent',
            index: 5,
            label: '编写代码',
            state: 'start',
            phaseIndex: 2,
            phaseTitle: '实现',
          },
        ],
      },
    }

    const [run] = buildWorkflowActivityRuns({ live })
    expect(run).toBeDefined()
    expect(run!.workflowName).toBe('release-flow')
    expect(run!.doneAgents).toBe(3)
    expect(run!.totalAgents).toBe(5)
    expect(run!.runningAgents).toBe(1)
    expect(run!.phases.map((p) => ({ title: p.title, done: p.done, total: p.total }))).toEqual([
      { title: '调研', done: 3, total: 4 },
      { title: '实现', done: 0, total: 1 },
      { title: '验证', done: 0, total: 0 },
    ])
    expect(
      run!.phases[0]!.agents.map((a) => ({
        label: a.label,
        status: a.status,
        text: workflowAgentStatusText(a.status),
        openable: a.openable,
      }))
    ).toEqual([
      { label: '分析接口', status: 'completed', text: '已完成', openable: true },
      { label: '扫描依赖', status: 'running', text: '运行中', openable: true },
      { label: '检查权限', status: 'failed', text: '失败', openable: true },
      { label: '可选审计', status: 'skipped', text: '跳过', openable: false },
    ])
    expect(run!.phases[1]!.agents[0]).toMatchObject({
      label: '编写代码',
      status: 'pending',
      openable: false,
    })
  })

  test('prefers live WS run over reconstructed run and falls back to running local_workflow background task', () => {
    const reconstructed: ReconstructedWorkflowRun[] = [
      {
        runId: 'wf_r1',
        taskId: 'wf-1',
        workflowName: 'disk-name',
        status: 'running',
        startedAt: 1000,
        updatedAt: 1500,
        agents: [
          { agentId: 'a1', label: 'old', phaseIndex: 1, phaseTitle: '调研', agentIndex: 1, state: 'start' },
        ],
      },
      {
        runId: 'wf_done',
        taskId: 'wf-done',
        workflowName: 'finished-flow',
        status: 'completed',
        startedAt: 500,
        updatedAt: 900,
        endedAt: 900,
        agents: [],
      },
    ]
    const live: Record<string, WorkflowLiveRun> = {
      'wf-1': {
        taskId: 'wf-1',
        runId: 'wf_r1',
        workflowName: 'live-name',
        status: 'running',
        startedAt: 1000,
        updatedAt: 2000,
        progress: [
          { type: 'workflow_phase', index: 1, title: '调研' },
          { type: 'workflow_agent', index: 1, label: 'live-agent', state: 'progress', phaseIndex: 1, agentId: 'a1' },
        ],
      },
    }
    const background: BackgroundTask[] = [
      { taskId: 'wf-1', taskType: 'local_workflow', description: 'live-name', status: 'running' },
      { taskId: 'wf-new', taskType: 'local_workflow', description: '刚启动的工作流', status: 'running' },
      { taskId: 'wf-done', taskType: 'local_workflow', description: 'finished-flow', status: 'completed' },
    ]
    const active = buildWorkflowActivityRuns({ live, reconstructed, background })
    expect(active.map((r) => r.workflowName)).toEqual(['live-name', '刚启动的工作流'])
    expect(active[0]!.phases[0]!.agents[0]!.label).toBe('live-agent')
    expect(active[1]!.phases).toEqual([])
  })

  test('server terminal state overrides stale live running entry for the same taskId, while a resumed fresh taskId still wins', () => {
    const staleLive: Record<string, WorkflowLiveRun> = {
      'wf-1': {
        taskId: 'wf-1',
        runId: 'wf_r1',
        workflowName: 'ship',
        status: 'running',
        startedAt: 1000,
        updatedAt: 2000,
        progress: [{ type: 'workflow_phase', index: 1, title: '调研' }],
      },
    }
    const terminalReconstructed: ReconstructedWorkflowRun[] = [
      {
        runId: 'wf_r1',
        taskId: 'wf-1',
        workflowName: 'ship',
        status: 'completed',
        startedAt: 1000,
        updatedAt: 3000,
        endedAt: 3000,
        agents: [],
      },
    ]
    expect(buildWorkflowActivityRuns({ live: staleLive, reconstructed: terminalReconstructed })).toEqual([])
    expect(hasActiveLiveWorkflow(staleLive, terminalReconstructed, [])).toBe(false)

    // Also cleared when only background-tasks reports terminal for the same taskId.
    const terminalBackground: BackgroundTask[] = [
      { taskId: 'wf-1', taskType: 'local_workflow', status: 'failed' },
    ]
    expect(buildWorkflowActivityRuns({ live: staleLive, background: terminalBackground })).toEqual([])
    expect(hasActiveLiveWorkflow(staleLive, [], terminalBackground)).toBe(false)

    // Resumed attempt has a fresh taskId for the same runId: stays active and replaces older terminal run.
    const resumedLive: Record<string, WorkflowLiveRun> = {
      'wf-2': {
        taskId: 'wf-2',
        runId: 'wf_r1',
        workflowName: 'ship',
        status: 'running',
        startedAt: 4000,
        updatedAt: 4100,
        progress: [{ type: 'workflow_phase', index: 2, title: '实现' }],
      },
    }
    const resumed = buildWorkflowActivityRuns({ live: resumedLive, reconstructed: terminalReconstructed })
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.taskId).toBe('wf-2')
    expect(hasActiveLiveWorkflow(resumedLive, terminalReconstructed, [])).toBe(true)

    // session_state reconnect prunes stale running workflows missing from activeBackgroundTaskIds.
    const startedState = chatReducer(createChatState('s1'), {
      type: 'system_notification',
      subtype: 'task_started',
      data: { task_id: 'wf-1', task_type: 'local_workflow', workflow_name: 'ship' },
    })
    expect(startedState.workflows?.['wf-1']?.status).toBe('running')
    const reconnected = chatReducer(startedState, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })
    expect(reconnected.workflows).toBeUndefined()
    expect(pruneInactiveRunningWorkflows(startedState.workflows, ['wf-1'])).toBe(startedState.workflows)
  })
})

describe('buildWorkflowHistoryRuns', () => {
  test('returns finished root runs newest first with phase titles and excludes running or child runs', () => {
    const reconstructed: ReconstructedWorkflowRun[] = [
      {
        runId: 'wf_running',
        taskId: 't-run',
        workflowName: 'still-running',
        status: 'running',
        startedAt: 5000,
        updatedAt: 5500,
        agents: [],
      },
      {
        runId: 'wf_child',
        taskId: 't-child',
        ownerAgentId: 'agent-1',
        workflowName: 'nested',
        status: 'completed',
        startedAt: 4000,
        updatedAt: 4500,
        endedAt: 4500,
        agents: [],
      },
      {
        runId: 'wf_old',
        taskId: 't-old',
        workflowName: 'audit',
        status: 'failed',
        startedAt: 1000,
        updatedAt: 1800,
        endedAt: 1800,
        error: 'Lint failed',
        agents: [
          { agentId: 'a1', label: 'A', phaseIndex: 1, phaseTitle: '调研', agentIndex: 1, state: 'done' },
          { agentId: 'a2', label: 'B', phaseIndex: 2, phaseTitle: '验证', agentIndex: 2, state: 'error' },
        ],
      },
      {
        runId: 'wf_new',
        taskId: 't-new',
        workflowName: 'feature',
        status: 'completed',
        startedAt: 3000,
        updatedAt: 3900,
        endedAt: 3900,
        progress: [
          { type: 'workflow_phase', index: 1, title: '调研' },
          { type: 'workflow_phase', index: 2, title: '实现' },
          { type: 'workflow_phase', index: 3, title: '验证' },
        ],
        agents: [],
      },
    ]
    const live: Record<string, WorkflowLiveRun> = {
      't-just-finished': {
        taskId: 't-just-finished',
        runId: 'wf_live_done',
        workflowName: 'quick-check',
        status: 'stopped',
        startedAt: 6000,
        updatedAt: 6200,
        endedAt: 6200,
        progress: [{ type: 'workflow_phase', index: 1, title: '检查' }],
      },
    }

    const history = buildWorkflowHistoryRuns({ reconstructed, live })
    expect(history.map((r) => ({ id: r.runId, name: r.workflowName, status: workflowRunStatusText(r.status), phases: r.phases.map((p) => p.title) }))).toEqual([
      { id: 'wf_live_done', name: 'quick-check', status: '已停止', phases: ['检查'] },
      { id: 'wf_new', name: 'feature', status: '已完成', phases: ['调研', '实现', '验证'] },
      { id: 'wf_old', name: 'audit', status: '失败', phases: ['调研', '验证'] },
    ])
  })

  test('deduplicates a finished live run without runId against reconstructed run sharing taskId', () => {
    const reconstructed: ReconstructedWorkflowRun[] = [
      {
        runId: 'wf_disk_id',
        taskId: 'wf-k',
        workflowName: 'deploy',
        status: 'stopped',
        startedAt: 1000,
        updatedAt: 2000,
        endedAt: 2000,
        agents: [],
      },
    ]
    const live: Record<string, WorkflowLiveRun> = {
      'wf-k': {
        taskId: 'wf-k',
        workflowName: 'deploy',
        status: 'stopped',
        startedAt: 1000,
        updatedAt: 2000,
        endedAt: 2000,
        error: 'Stopped by user',
        progress: [{ type: 'workflow_phase', index: 1, title: '构建' }],
      },
    }
    const history = buildWorkflowHistoryRuns({ reconstructed, live })
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      runId: 'wf_disk_id',
      taskId: 'wf-k',
      error: 'Stopped by user',
      phases: [{ index: 1, title: '构建' }],
    })
  })
})

describe('workflow API loaders', () => {
  test('escapes IDs and handles 403/404 gracefully on safe loaders', async () => {
    const urls: string[] = []
    const makeClient = (status: number, body: unknown) =>
      new ApiClient({ id: 'h', name: 'H', url: 'http://127.0.0.1:3456', auth: 'lan' }, 'tok', {
        fetch: async (url) => {
          urls.push(url)
          return {
            ok: status >= 200 && status < 300,
            status,
            url,
            redirected: false,
            text: async () => JSON.stringify(body),
          }
        },
      })

    const okClient = makeClient(200, {
      runs: [
        { runId: 'wf_1', taskId: 't1', workflowName: 'a', status: 'completed', startedAt: 1, updatedAt: 2, agents: [] },
        { runId: 'wf_2', taskId: 't2', ownerAgentId: 'child', workflowName: 'b', status: 'completed', startedAt: 1, updatedAt: 2, agents: [] },
      ],
    })
    const loaded = await loadSessionWorkflowRuns(okClient, 's/1')
    expect(loaded.map((r) => r.runId)).toEqual(['wf_1'])
    expect(urls[0]).toBe('http://127.0.0.1:3456/api/workflows/session-runs/s%2F1')

    const forbiddenClient = makeClient(403, { error: 'WORKFLOWS_DISABLED' })
    expect(await loadSessionWorkflowRunsSafe(forbiddenClient, 's/1')).toEqual([])
    expect(await loadWorkflowRunDetail(forbiddenClient, 's/1', 'wf_1')).toBeNull()
    expect(urls.at(-1)).toBe('http://127.0.0.1:3456/api/workflows/runs/s%2F1/wf_1')
  })
})
