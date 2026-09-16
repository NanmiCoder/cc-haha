import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetStateForTests, setIsInteractive } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import type {
  CustomAgentDefinition,
  PluginAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import * as runAgentModule from '../../tools/AgentTool/runAgent.js'
import { TaskUpdateTool } from '../../tools/TaskUpdateTool/TaskUpdateTool.js'
import * as lockfile from '../lockfile.js'
import { drainSdkEvents } from '../sdkEventQueue.js'
import {
  blockTask,
  claimTask,
  createTask,
  deleteTask,
  getTask,
  getTaskPath,
  getTasksDir,
  listTasks,
  unassignTeammateTasks,
  updateTask,
} from '../tasks.js'
import {
  createTeammateContext,
  getTeammateContext,
  runWithTeammateContext,
} from '../teammateContext.js'
import { readMailbox } from '../teammateMailbox.js'
import {
  buildInProcessTeammateAgentDefinition,
  claimNextInProcessTask,
  runInProcessTeammate,
  withInProcessTeammateActivity,
} from './inProcessRunner.js'
import * as teamHelpers from './teamHelpers.js'
import {
  readTeamFile,
  type TeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'

async function withTempConfig(
  run: (configDir: string) => Promise<void>,
): Promise<void> {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-in-process-runner-'))
  process.env.CLAUDE_CONFIG_DIR = configDir

  try {
    await run(configDir)
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  }
}

async function waitForFileLock(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await lockfile.check(filePath)) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for lock: ${filePath}`)
}

async function yieldEventLoop(turns = 1): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

function createMember(
  name: string,
  teamName: string,
  isActive = false,
): TeamFile['members'][number] {
  return {
    agentId: `${name}@${teamName}`,
    name,
    joinedAt: Date.now(),
    tmuxPaneId: '',
    cwd: process.cwd(),
    subscriptions: [],
    backendType: 'in-process',
    isActive,
  }
}

describe('buildInProcessTeammateAgentDefinition', () => {
  test('preserves model and effort from the selected custom agent', () => {
    const selectedAgent: CustomAgentDefinition = {
      agentType: 'deep-reviewer',
      whenToUse: 'Review deeply',
      rawSystemPrompt: 'Review carefully',
      getSystemPrompt: () => 'Review carefully',
      source: 'projectSettings',
      tools: ['Read'],
      model: 'opus',
      effort: 'xhigh',
    }

    const resolved = buildInProcessTeammateAgentDefinition(
      'reviewer-1',
      'Team prompt',
      selectedAgent,
    )

    expect(resolved.model).toBe('opus')
    expect(resolved.effort).toBe('xhigh')
    expect(resolved.tools).toContain('Read')
    expect(resolved.tools).toContain('SendMessage')
    expect(resolved.rawSystemPrompt).toBe('Team prompt')
    expect(resolved.getSystemPrompt()).toBe('Team prompt')
  })

  test('inherits session effort when no custom agent effort is present', () => {
    const resolved = buildInProcessTeammateAgentDefinition(
      'generalist',
      'Team prompt',
    )

    expect(resolved.effort).toBeUndefined()
    expect(resolved.tools).toEqual(['*'])
  })

  test('preserves tools, model, and effort from a selected plugin Agent', () => {
    const selectedAgent: PluginAgentDefinition = {
      agentType: 'plugin-reviewer',
      whenToUse: 'Review with the plugin',
      getSystemPrompt: () => 'Apply the plugin review policy.',
      source: 'plugin',
      plugin: 'review-suite',
      tools: ['Read'],
      model: 'haiku',
      effort: 'low',
    }

    const resolved = buildInProcessTeammateAgentDefinition(
      'reviewer-2',
      selectedAgent.getSystemPrompt(),
      selectedAgent,
    )

    expect(resolved.model).toBe('haiku')
    expect(resolved.effort).toBe('low')
    expect(resolved.tools).toContain('Read')
    expect(resolved.tools).toContain('SendMessage')
    expect(resolved.rawSystemPrompt).toBe('Apply the plugin review policy.')
  })
})

describe('in-process teammate task claiming', () => {
  test('serializes both sides of concurrent dependency edges under one list lock', async () => {
    await withTempConfig(async () => {
      const taskListId = 'concurrent-dependency-edges'
      const sourceId = await createTask(taskListId, {
        subject: 'Source', description: 'Blocks both targets', status: 'pending',
        blocks: [], blockedBy: [],
      })
      const firstTargetId = await createTask(taskListId, {
        subject: 'First target', description: 'First dependency', status: 'pending',
        blocks: [], blockedBy: [],
      })
      const secondTargetId = await createTask(taskListId, {
        subject: 'Second target', description: 'Second dependency', status: 'pending',
        blocks: [], blockedBy: [],
      })
      const listLockPath = join(getTasksDir(taskListId), '.lock')
      const releaseBarrier = await lockfile.lock(listLockPath)

      const firstEdge = blockTask(taskListId, sourceId, firstTargetId)
      const secondEdge = blockTask(taskListId, sourceId, secondTargetId)
      await yieldEventLoop(10)
      await releaseBarrier()

      expect(await Promise.all([firstEdge, secondEdge])).toEqual([true, true])
      expect((await getTask(taskListId, sourceId))?.blocks.sort()).toEqual([
        firstTargetId,
        secondTargetId,
      ].sort())
      expect((await getTask(taskListId, firstTargetId))?.blockedBy).toEqual([sourceId])
      expect((await getTask(taskListId, secondTargetId))?.blockedBy).toEqual([sourceId])
    })
  })

  test('rechecks automatic TaskUpdate ownership after a concurrent leader assignment', async () => {
    await withTempConfig(async () => {
      const taskListId = 'task-update-owner-race'
      const taskId = await createTask(taskListId, {
        subject: 'Keep the leader assignment', description: 'Do not auto-own from stale state',
        status: 'pending', blocks: [], blockedBy: [],
      })
      const taskPath = getTaskPath(taskListId, taskId)
      const listLockPath = join(getTasksDir(taskListId), '.lock')
      let releaseTaskBarrier: (() => Promise<void>) | undefined = await lockfile.lock(taskPath)
      const originalUserType = process.env.USER_TYPE
      process.env.USER_TYPE = 'ant'

      try {
        const leaderAssignment = updateTask(taskListId, taskId, {
          owner: 'leader-assignee',
          status: 'in_progress',
        })
        await waitForFileLock(listLockPath)

        const teammateContext = createTeammateContext({
          agentId: 'idle-agent@task-update-owner-race',
          agentName: 'idle-agent',
          teamName: taskListId,
          planModeRequired: false,
          parentSessionId: 'leader-session',
          abortController: new AbortController(),
        })
        const toolContext = {
          agentId: 'idle-agent@task-update-owner-race',
          abortController: new AbortController(),
          setAppState: () => {},
        } as unknown as ToolUseContext
        const teammateUpdate = runWithTeammateContext(
          teammateContext,
          () => TaskUpdateTool.call({ taskId, status: 'in_progress' }, toolContext),
        )
        await yieldEventLoop(4)

        await releaseTaskBarrier()
        releaseTaskBarrier = undefined
        await leaderAssignment
        expect((await teammateUpdate).data).toMatchObject({
          success: true,
          updatedFields: [],
        })
        expect(await getTask(taskListId, taskId)).toMatchObject({
          owner: 'leader-assignee',
          status: 'in_progress',
        })
      } finally {
        await releaseTaskBarrier?.()
        if (originalUserType === undefined) delete process.env.USER_TYPE
        else process.env.USER_TYPE = originalUserType
      }
    })
  })

  test('automatically owns an unassigned task when a teammate starts it', async () => {
    await withTempConfig(async () => {
      const taskListId = 'task-update-auto-owner'
      const taskId = await createTask(taskListId, {
        subject: 'Start assigned work',
        description: 'The first in-progress transition should record its teammate',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const originalUserType = process.env.USER_TYPE
      process.env.USER_TYPE = 'ant'
      const teammateContext = createTeammateContext({
        agentId: 'worker@task-update-auto-owner',
        agentName: 'worker',
        teamName: taskListId,
        planModeRequired: false,
        parentSessionId: 'leader-session',
        abortController: new AbortController(),
      })
      const toolContext = {
        agentId: 'worker@task-update-auto-owner',
        abortController: new AbortController(),
        setAppState: () => {},
      } as unknown as ToolUseContext

      try {
        const result = await runWithTeammateContext(
          teammateContext,
          () => TaskUpdateTool.call({ taskId, status: 'in_progress' }, toolContext),
        )

        expect(result.data).toMatchObject({
          success: true,
          updatedFields: ['owner', 'status'],
          statusChange: { from: 'pending', to: 'in_progress' },
        })
        expect(await getTask(taskListId, taskId)).toMatchObject({
          owner: 'worker',
          status: 'in_progress',
        })
      } finally {
        if (originalUserType === undefined) delete process.env.USER_TYPE
        else process.env.USER_TYPE = originalUserType
      }
    })
  })

  test('records the teammate that closes a task it never marked in progress', async () => {
    await withTempConfig(async () => {
      const taskListId = 'task-update-batch-owner'
      const taskId = await createTask(taskListId, {
        subject: 'Close batched work',
        description: 'Small tasks get resolved together without ever starting',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const originalUserType = process.env.USER_TYPE
      process.env.USER_TYPE = 'ant'
      const teammateContext = createTeammateContext({
        agentId: 'worker@task-update-batch-owner',
        agentName: 'worker',
        teamName: taskListId,
        planModeRequired: false,
        parentSessionId: 'leader-session',
        abortController: new AbortController(),
      })
      const toolContext = {
        agentId: 'worker@task-update-batch-owner',
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => {},
      } as unknown as ToolUseContext

      try {
        await runWithTeammateContext(
          teammateContext,
          () => TaskUpdateTool.call({ taskId, status: 'completed' }, toolContext),
        )

        expect(await getTask(taskListId, taskId)).toMatchObject({
          owner: 'worker',
          status: 'completed',
        })
        // Handing someone a task that is already finished is not an assignment,
        // and delivering one would wake an idle teammate for nothing.
        expect(await readMailbox('worker', taskListId)).toEqual([])
      } finally {
        if (originalUserType === undefined) delete process.env.USER_TYPE
        else process.env.USER_TYPE = originalUserType
      }
    })
  })

  test('leaves a task ownerless when the lead closes it from the main thread', async () => {
    await withTempConfig(async () => {
      const taskListId = 'task-update-lead-close'
      const taskId = await createTask(taskListId, {
        subject: 'Close on behalf of the team',
        description: 'The lead resolving a task must not take credit for it',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const originalUserType = process.env.USER_TYPE
      const originalTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
      process.env.USER_TYPE = 'ant'
      process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId
      const toolContext = {
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => {},
      } as unknown as ToolUseContext

      try {
        // No teammate context: this is the lead's own thread, which has no
        // agent name, so automatic attribution has to stay out of it.
        await TaskUpdateTool.call({ taskId, status: 'completed' }, toolContext)

        const task = await getTask(taskListId, taskId)
        expect(task?.status).toBe('completed')
        expect(task?.owner).toBeUndefined()
      } finally {
        if (originalUserType === undefined) delete process.env.USER_TYPE
        else process.env.USER_TYPE = originalUserType
        if (originalTaskListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
        else process.env.CLAUDE_CODE_TASK_LIST_ID = originalTaskListId
      }
    })
  })

  test('still announces an assignment when unfinished work changes hands', async () => {
    await withTempConfig(async () => {
      const taskListId = 'task-update-open-assignment'
      const taskId = await createTask(taskListId, {
        subject: 'Hand over open work',
        description: 'An unfinished task still has to reach its new owner',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const originalUserType = process.env.USER_TYPE
      const originalTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
      process.env.USER_TYPE = 'ant'
      process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId
      const toolContext = {
        abortController: new AbortController(),
        setAppState: () => {},
      } as unknown as ToolUseContext

      try {
        await TaskUpdateTool.call({ taskId, owner: 'worker' }, toolContext)

        const delivered = await readMailbox('worker', taskListId)
        expect(delivered).toHaveLength(1)
        expect(JSON.parse(delivered[0]!.text)).toMatchObject({
          type: 'task_assignment',
          taskId,
        })
      } finally {
        if (originalUserType === undefined) delete process.env.USER_TYPE
        else process.env.USER_TYPE = originalUserType
        if (originalTaskListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
        else process.env.CLAUDE_CODE_TASK_LIST_ID = originalTaskListId
      }
    })
  })

  test('does not unassign a task after another actor reassigns it', async () => {
    await withTempConfig(async () => {
      const taskListId = 'shutdown-reassignment-race'
      const taskId = await createTask(taskListId, {
        subject: 'Preserve reassignment', description: 'Shutdown cleanup must use owner CAS',
        owner: 'exiting-agent', status: 'in_progress', blocks: [], blockedBy: [],
      })
      const taskPath = getTaskPath(taskListId, taskId)
      const listLockPath = join(getTasksDir(taskListId), '.lock')
      let releaseTaskBarrier: (() => Promise<void>) | undefined = await lockfile.lock(taskPath)

      try {
        const reassignment = updateTask(taskListId, taskId, {
          owner: 'replacement-agent',
          status: 'in_progress',
        })
        await waitForFileLock(listLockPath)
        const cleanup = unassignTeammateTasks(
          taskListId,
          'exiting-agent@shutdown-reassignment-race',
          'exiting-agent',
          'shutdown',
        )
        await yieldEventLoop(4)

        await releaseTaskBarrier()
        releaseTaskBarrier = undefined
        await reassignment
        expect(await cleanup).toMatchObject({ unassignedTasks: [] })
        expect(await getTask(taskListId, taskId)).toMatchObject({
          owner: 'replacement-agent',
          status: 'in_progress',
        })
      } finally {
        await releaseTaskBarrier?.()
      }
    })
  })

  test('returns genuinely unassigned teammate work to the pending pool', async () => {
    await withTempConfig(async () => {
      const taskListId = 'shutdown-positive-unassign'
      const taskId = await createTask(taskListId, {
        subject: 'Hand work back to the team',
        description: 'Shutdown cleanup should release work still owned by the exiting member',
        owner: 'exiting-agent',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
      })

      const result = await unassignTeammateTasks(
        taskListId,
        'exiting-agent@shutdown-positive-unassign',
        'exiting-agent',
        'shutdown',
      )

      expect(result.unassignedTasks).toEqual([{
        id: taskId,
        subject: 'Hand work back to the team',
      }])
      expect(result.notificationMessage).toContain('1 task(s) were unassigned')
      expect(await getTask(taskListId, taskId)).toMatchObject({ status: 'pending' })
      expect((await getTask(taskListId, taskId))?.owner).toBeUndefined()
    })
  })

  test('marks a claim in progress only when the caller explicitly requests it', async () => {
    await withTempConfig(async () => {
      const taskListId = 'claim-status-contract'
      const pendingClaim = await createTask(taskListId, {
        subject: 'Keep pending',
        description: 'Legacy claim callers only assign an owner',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const activeClaim = await createTask(taskListId, {
        subject: 'Start immediately',
        description: 'In-process idle claiming activates atomically',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })

      expect(await claimTask(taskListId, pendingClaim, 'legacy-agent'))
        .toMatchObject({ success: true, task: { owner: 'legacy-agent', status: 'pending' } })
      expect(await claimTask(taskListId, activeClaim, 'idle-agent', {
        markInProgress: true,
      })).toMatchObject({
        success: true,
        task: { owner: 'idle-agent', status: 'in_progress' },
      })
    })
  })

  test('does not overwrite a leader owner/status update committed before a busy claim', async () => {
    await withTempConfig(async () => {
      const taskListId = 'claim-after-owner-update'
      const taskId = await createTask(taskListId, {
        subject: 'Leader-owned task',
        description: 'The idle claimant must observe the serialized assignment',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const taskPath = getTaskPath(taskListId, taskId)
      const listLockPath = join(getTasksDir(taskListId), '.lock')
      let releaseTaskBarrier: (() => Promise<void>) | undefined = await lockfile.lock(taskPath)

      try {
        const leaderUpdate = updateTask(taskListId, taskId, {
          owner: 'leader-assignee',
          status: 'in_progress',
        })
        await waitForFileLock(listLockPath)

        let claimSettled = false
        const idleClaim = claimTask(taskListId, taskId, 'idle-claimant', {
          checkAgentBusy: true,
          markInProgress: true,
        }).finally(() => {
          claimSettled = true
        })
        await yieldEventLoop(4)
        expect(claimSettled).toBe(false)

        await releaseTaskBarrier()
        releaseTaskBarrier = undefined
        expect(await leaderUpdate).toMatchObject({
          owner: 'leader-assignee',
          status: 'in_progress',
        })
        expect(await idleClaim).toMatchObject({
          success: false,
          reason: 'already_claimed',
          task: {
            owner: 'leader-assignee',
            status: 'in_progress',
          },
        })
        expect(await getTask(taskListId, taskId)).toMatchObject({
          owner: 'leader-assignee',
          status: 'in_progress',
        })
      } finally {
        await releaseTaskBarrier?.()
      }
    })
  })

  test('serializes a new busy assignment before claiming different follow-up work', async () => {
    await withTempConfig(async () => {
      const taskListId = 'claim-after-busy-update'
      const busyTaskId = await createTask(taskListId, {
        subject: 'Fresh leader assignment',
        description: 'This update must participate in the claim transaction',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const followUpTaskId = await createTask(taskListId, {
        subject: 'Unowned follow-up',
        description: 'Must remain available while the member is busy',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const busyTaskPath = getTaskPath(taskListId, busyTaskId)
      const listLockPath = join(getTasksDir(taskListId), '.lock')
      let releaseTaskBarrier: (() => Promise<void>) | undefined = await lockfile.lock(busyTaskPath)

      try {
        const leaderUpdate = updateTask(taskListId, busyTaskId, {
          owner: 'idle-claimant',
          status: 'in_progress',
        })
        await waitForFileLock(listLockPath)
        const idleClaim = claimTask(
          taskListId,
          followUpTaskId,
          'idle-claimant',
          { checkAgentBusy: true, markInProgress: true },
        )

        await releaseTaskBarrier()
        releaseTaskBarrier = undefined
        await leaderUpdate
        expect(await idleClaim).toMatchObject({
          success: false,
          reason: 'agent_busy',
          busyWithTasks: [busyTaskId],
        })
        expect(await getTask(taskListId, followUpTaskId)).toMatchObject({
          status: 'pending',
        })
        expect((await getTask(taskListId, followUpTaskId))?.owner).toBeUndefined()
      } finally {
        await releaseTaskBarrier?.()
      }
    })
  })

  test('does not let delete turn a serialized busy claim into success without a task', async () => {
    await withTempConfig(async () => {
      const taskListId = 'delete-during-claim'
      const taskId = await createTask(taskListId, {
        subject: 'Claim or delete atomically',
        description: 'A successful claim must always carry the committed task',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const taskPath = getTaskPath(taskListId, taskId)
      const listLockPath = join(getTasksDir(taskListId), '.lock')
      let releaseTaskBarrier: (() => Promise<void>) | undefined = await lockfile.lock(taskPath)

      try {
        const idleClaim = claimTask(taskListId, taskId, 'idle-claimant', {
          checkAgentBusy: true,
          markInProgress: true,
        })
        await waitForFileLock(listLockPath)

        let deleteSettled = false
        const deletion = deleteTask(taskListId, taskId).finally(() => {
          deleteSettled = true
        })
        await yieldEventLoop(20)
        expect(deleteSettled).toBe(false)
        expect(await getTask(taskListId, taskId)).not.toBeNull()

        await releaseTaskBarrier()
        releaseTaskBarrier = undefined
        expect(await idleClaim).toMatchObject({
          success: true,
          task: {
            id: taskId,
            owner: 'idle-claimant',
            status: 'in_progress',
          },
        })
        expect(await deletion).toBe(true)
        expect(await getTask(taskListId, taskId)).toBeNull()
      } finally {
        await releaseTaskBarrier?.()
      }
    })
  })

  test('claims follow-up work from the team list instead of the parent session list', async () => {
    await withTempConfig(async () => {
      const teamName = 'Release_Audit'
      const taskListId = 'release-audit'
      const parentSessionId = 'leader-session'
      const agentName = 'workflow-analyzer'

      const explicitAssignment = await createTask(taskListId, {
        subject: 'Completed explicit assignment',
        description: 'Establish that the lead assigned this teammate',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      await updateTask(taskListId, explicitAssignment, {
        owner: agentName,
        status: 'in_progress',
      })
      await updateTask(taskListId, explicitAssignment, { status: 'completed' })
      const followUpTaskId = await createTask(taskListId, {
        subject: 'Audit workflow',
        description: 'Audit workflow changes',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      await createTask(parentSessionId, {
        subject: 'Unrelated session task',
        description: 'Must not be claimed by a teammate',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })

      const prompt = await claimNextInProcessTask({ agentName, teamName })

      expect(prompt).toContain('Audit workflow')
      const claimedTasks = await listTasks(taskListId)
      const claimedTask = claimedTasks.find(task => task.id === followUpTaskId)
      expect(claimedTask?.owner).toBe(agentName)
      expect(claimedTask?.status).toBe('in_progress')

      const unrelatedTasks = await listTasks(parentSessionId)
      expect(unrelatedTasks).toHaveLength(1)
      expect(unrelatedTasks[0]?.owner).toBeUndefined()
      expect(unrelatedTasks[0]?.status).toBe('pending')

      expect(await claimNextInProcessTask({ agentName, teamName })).toBeUndefined()
    })
  })

  test('lets concurrent members fall through to distinct available tasks', async () => {
    await withTempConfig(async () => {
      const teamName = 'parallel-audit'
      const agentNames = ['workflow-analyzer', 'desktop-analyzer', 'provider-analyzer']
      for (const agentName of agentNames) {
        await createTask(teamName, {
          subject: `Completed assignment for ${agentName}`,
          description: 'Establish prior explicit ownership',
          status: 'completed',
          owner: agentName,
          blocks: [],
          blockedBy: [],
        })
      }
      for (const subject of ['Audit workflow', 'Audit desktop', 'Audit providers']) {
        await createTask(teamName, {
          subject,
          description: subject,
          status: 'pending',
          blocks: [],
          blockedBy: [],
        })
      }

      const prompts = await Promise.all(agentNames.map(agentName =>
        claimNextInProcessTask({ agentName, teamName }),
      ))

      expect(prompts.every(Boolean)).toBe(true)
      const claimedTasks = await listTasks(teamName)
      const followUpTasks = claimedTasks.filter(task => task.status === 'in_progress')
      expect(followUpTasks.map(task => task.owner).sort()).toEqual([...agentNames].sort())
    })
  })

  test('keeps teammate claims on the canonical Team list despite a standalone override', async () => {
    await withTempConfig(async () => {
      const previousTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
      process.env.CLAUDE_CODE_TASK_LIST_ID = 'explicit-team-list'
      try {
        await createTask('ignored-team-name', {
          subject: 'Completed canonical assignment',
          description: 'Establish prior explicit ownership',
          status: 'completed',
          owner: 'auditor',
          blocks: [],
          blockedBy: [],
        })
        await createTask('ignored-team-name', {
          subject: 'Audit canonical Team list',
          description: 'Do not split Team work into the standalone override',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        })

        expect(await claimNextInProcessTask({
          agentName: 'auditor',
          teamName: 'Ignored_Team_Name',
        })).toContain('Audit canonical Team list')
        const canonicalTask = (await listTasks('ignored-team-name'))
          .find(task => task.subject === 'Audit canonical Team list')
        expect(canonicalTask).toMatchObject({
          owner: 'auditor',
          status: 'in_progress',
        })
        expect(await listTasks('explicit-team-list')).toEqual([])
      } finally {
        if (previousTaskListId === undefined) {
          delete process.env.CLAUDE_CODE_TASK_LIST_ID
        } else {
          process.env.CLAUDE_CODE_TASK_LIST_ID = previousTaskListId
        }
      }
    })
  })

  test('waits for a lead owner assignment before opportunistically claiming work', async () => {
    await withTempConfig(async () => {
      const teamName = 'assignment-barrier'
      await createTask(teamName, {
        subject: 'Feature analysis',
        description: 'Must not be attached to an arbitrary spawn prompt',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })

      expect(await claimNextInProcessTask({
        agentName: 'bug-analyst',
        teamName,
      })).toBeUndefined()
      expect((await listTasks(teamName))[0]).toMatchObject({
        status: 'pending',
      })
      expect((await listTasks(teamName))[0]?.owner).toBeUndefined()
    })
  })

  test('does not claim another task while the teammate owns unfinished work', async () => {
    await withTempConfig(async () => {
      const teamName = 'busy-claim-guard'
      const agentName = 'reviewer'
      await createTask(teamName, {
        subject: 'Current review',
        description: 'The teammate is still working on this assignment',
        status: 'in_progress',
        owner: agentName,
        blocks: [],
        blockedBy: [],
      })
      await createTask(teamName, {
        subject: 'Unclaimed follow-up',
        description: 'Must stay available for another idle teammate',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })

      expect(await claimNextInProcessTask({ agentName, teamName })).toBeUndefined()
      const followUp = (await listTasks(teamName))
        .find(task => task.subject === 'Unclaimed follow-up')
      expect(followUp?.owner).toBeUndefined()
      expect(followUp?.status).toBe('pending')
    })
  })
})

describe('in-process teammate activity synchronization', () => {
  test('synchronizes active and idle turn transitions to the team roster', async () => {
    await withTempConfig(async () => {
      const teamName = 'activity-team'
      const member = createMember('worker', teamName)
      await writeTeamFileAsync(teamName, {
        name: teamName,
        createdAt: Date.now(),
        leadAgentId: `team-lead@${teamName}`,
        members: [member],
      })

      await expect(withInProcessTeammateActivity(
        { agentName: member.name, teamName },
        async () => {
          expect(readTeamFile(teamName)?.members[0]?.isActive).toBe(true)
          throw new Error('turn failed')
        },
      )).rejects.toThrow('turn failed')
      expect(readTeamFile(teamName)?.members[0]?.isActive).toBe(false)
    })
  })

  test('keeps the turn running when roster activity persistence fails', async () => {
    const setMemberActive = spyOn(
      teamHelpers,
      'setMemberActive',
    ).mockImplementation(async () => {
      throw new Error('roster unavailable')
    })

    try {
      await expect(withInProcessTeammateActivity(
        { agentName: 'worker', teamName: 'activity-team' },
        async () => 'turn completed',
      )).resolves.toBe('turn completed')
      expect(setMemberActive).toHaveBeenCalledTimes(2)
    } finally {
      setMemberActive.mockRestore()
    }
  })

  test('keeps the leader-assigned first turn separate from opportunistic task claiming', async () => {
    await withTempConfig(async () => {
      resetStateForTests()
      setIsInteractive(false)
      drainSdkEvents()

      const teamName = 'first-turn-team'
      const agentName = 'worker'
      const taskId = 'in-process-worker'
      const abortController = new AbortController()
      const identity: TeammateIdentity = {
        agentId: `${agentName}@${teamName}`,
        agentName,
        teamName,
        planModeRequired: false,
        parentSessionId: 'leader-session',
      }
      const member = createMember(agentName, teamName)
      const teamFile: TeamFile = {
        name: teamName,
        createdAt: Date.now(),
        leadAgentId: `team-lead@${teamName}`,
        leadSessionId: identity.parentSessionId,
        members: [member],
      }
      await writeTeamFileAsync(teamName, teamFile)
      await createTask(teamName, {
        subject: 'Earlier explicit assignment',
        description: 'Makes an accidental first-turn claim observable',
        status: 'completed',
        owner: agentName,
        blocks: [],
        blockedBy: [],
      })
      await createTask(teamName, {
        subject: 'Audit first-turn delivery',
        description: 'Verify the claimed task reaches runAgent',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })

      const teammateTask: InProcessTeammateTaskState = {
        id: taskId,
        type: 'in_process_teammate',
        status: 'running',
        description: 'First-turn worker',
        toolUseId: 'team-member-tool',
        startTime: Date.now(),
        outputFile: '/tmp/in-process-worker.output',
        outputOffset: 0,
        notified: false,
        identity,
        prompt: 'Review the release',
        abortController,
        awaitingPlanApproval: false,
        permissionMode: 'default',
        isIdle: false,
        shutdownRequested: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
        pendingUserMessages: [],
        messages: [],
      }
      let state = {
        tasks: { [taskId]: teammateTask },
      } as unknown as AppState
      const setAppState = (updater: (prev: AppState) => AppState) => {
        state = updater(state)
      }
      const toolUseContext = {
        options: {
          tools: [],
          mainLoopModel: 'test-model',
        },
        getAppState: () => state,
        setAppState,
      } as unknown as ToolUseContext

      let firstPrompt = ''
      let streamTargetAgentId: string | undefined
      let streamScopeId: string | undefined
      const runAgent = spyOn(runAgentModule, 'runAgent').mockImplementation(
        async function* (input: Parameters<typeof runAgentModule.runAgent>[0]) {
          firstPrompt = JSON.stringify(input.promptMessages[0])
          streamTargetAgentId = input.streamTargetAgentId
          streamScopeId = getTeammateContext()?.streamScopeId
          expect(readTeamFile(teamName)?.members[0]?.isActive).toBe(true)
          abortController.abort()
        },
      )

      try {
        const result = await runInProcessTeammate({
          identity,
          taskId,
          prompt: teammateTask.prompt,
          teammateContext: createTeammateContext({
            ...identity,
            abortController,
          }),
          toolUseContext,
          abortController,
          systemPrompt: 'Test teammate prompt',
          systemPromptMode: 'replace',
        })

        expect(result.success).toBe(true)
        expect(firstPrompt).toContain('Review the release')
        expect(firstPrompt).not.toContain('Audit first-turn delivery')
        expect(streamTargetAgentId).toBe(identity.agentId)
        expect(streamScopeId).toBe(JSON.stringify([
          teamName,
          identity.parentSessionId,
          teamFile.createdAt,
        ]))
        expect(readTeamFile(teamName)?.members[0]?.isActive).toBe(false)
        const unclaimedTask = (await listTasks(teamName))
          .find(task => task.subject === 'Audit first-turn delivery')
        expect(unclaimedTask?.owner).toBeUndefined()
        expect(unclaimedTask?.status).toBe('pending')
        expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
          owner_agent_id: identity.agentId,
        }))
      } finally {
        runAgent.mockRestore()
        drainSdkEvents()
        resetStateForTests()
      }
    })
  })
})
