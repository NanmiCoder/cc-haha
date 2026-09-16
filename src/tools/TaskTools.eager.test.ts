import { describe, expect, it } from 'bun:test'
import { AsyncResource } from 'node:async_hooks'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import { getSessionCreatedTeams } from '../bootstrap/state.js'
import {
  mutateTeamFileAsync,
  removeTeammateFromTeamFile,
} from '../utils/swarm/teamHelpers.js'
import {
  blockTask,
  beginTaskListLifecycle,
  claimTask,
  clearLeaderTeamName,
  createTaskWithCommit,
  deleteTaskWithCommit,
  getCanonicalTeamTaskListId,
  getTasksDir,
  readTaskListLifecycleState,
  readTaskListSnapshot,
  resetTaskList,
  updateTask,
  withTaskListLifecycleLock,
} from '../utils/tasks.js'
import { TaskCreateTool } from './TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './TaskGetTool/TaskGetTool.js'
import { TaskListTool } from './TaskListTool/TaskListTool.js'
import { TaskUpdateTool } from './TaskUpdateTool/TaskUpdateTool.js'
import { TeamDeleteTool } from './TeamDeleteTool/TeamDeleteTool.js'
import { TeamCreateTool } from './TeamCreateTool/TeamCreateTool.js'
import { isDeferredTool } from './ToolSearchTool/prompt.js'

describe('Task tool discovery', () => {
  it('keeps the complete task lifecycle available without ToolSearch', () => {
    for (const tool of [
      TaskCreateTool,
      TaskGetTool,
      TaskListTool,
      TaskUpdateTool,
    ]) {
      expect(tool.alwaysLoad).toBe(true)
      expect(isDeferredTool(tool)).toBe(false)
    }
  })
})

describe('Task tool execution ordering', () => {
  it('serializes task reads against concurrent task mutations', () => {
    expect(TaskGetTool.isConcurrencySafe({ taskId: '1' })).toBe(false)
    expect(TaskListTool.isConcurrencySafe({})).toBe(false)
  })

  it('joins TeamCreate, shared TaskCreate, and TeamDelete through one lifecycle token', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'team-tool-lifecycle-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_TASK_LIST_ID
    let appState: Record<string, unknown> = {
      expandedView: undefined,
      inbox: { messages: [] },
    }
    const context = {
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: (update: (prev: Record<string, unknown>) => Record<string, unknown>) => {
        appState = update(appState)
      },
    } as unknown as ToolUseContext

    try {
      const createdTeam = await TeamCreateTool.call({
        team_name: 'My Tool Team',
        description: 'Exercise the real lifecycle join',
      }, context)
      expect(createdTeam.data.team_name).toBe('My Tool Team')
      const active = await readTaskListLifecycleState('my-tool-team')
      expect(active).toMatchObject({
        generation: 1,
        deleted: false,
        activeIdentity: {
          teamName: 'My Tool Team',
          createdAt: expect.any(Number),
        },
      })
      expect(getSessionCreatedTeams().get('My Tool Team')).toEqual({
        generation: 1,
        identity: active.activeIdentity,
      })

      await mutateTeamFileAsync('My Tool Team', teamFile => ({
        ...teamFile,
        members: [...teamFile.members, {
          agentId: 'idle-worker@My Tool Team',
          name: 'idle-worker',
          agentType: 'worker',
          model: 'claude-sonnet-4-20250514',
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: configDir,
          subscriptions: [],
          isActive: false,
        }],
      }))
      const deniedWhileIdle = await TeamDeleteTool.call({}, context)
      expect(deniedWhileIdle.data).toMatchObject({
        success: false,
        team_name: 'My Tool Team',
        message: expect.stringContaining('registered teammate'),
      })
      expect((await readTaskListLifecycleState('my-tool-team')).deleted).toBe(false)
      expect(removeTeammateFromTeamFile('My Tool Team', {
        agentId: 'idle-worker@My Tool Team',
      })).toBe(true)

      const task = await TaskCreateTool.call({
        subject: 'Shared lifecycle task',
        description: 'Must land in the Team task list',
        activeForm: 'Testing lifecycle join',
      }, context)
      expect(task.data.taskListMutationRevision).toBe(1)

      const deleted = await TeamDeleteTool.call({}, context)
      expect(deleted.data).toMatchObject({
        success: true,
        team_name: 'My Tool Team',
        taskListSnapshotRevision: 1,
        finalTasks: [{
          id: task.data.task.id,
          subject: 'Shared lifecycle task',
        }],
      })
      const terminal = await readTaskListLifecycleState('my-tool-team')
      expect(terminal).toMatchObject({
        generation: 1,
        deleted: true,
        terminals: [{
          generation: 1,
          revision: 1,
          identity: { teamName: 'My Tool Team' },
        }],
      })
      expect(getSessionCreatedTeams().has('My Tool Team')).toBe(false)
      await expect(stat(getTasksDir('my-tool-team'))).rejects.toThrow()
    } finally {
      getSessionCreatedTeams().delete('My Tool Team')
      clearLeaderTeamName()
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousTaskListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
      else process.env.CLAUDE_CODE_TASK_LIST_ID = previousTaskListId
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('atomically reserves distinct names for concurrent TeamCreate calls', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'team-create-race-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_TASK_LIST_ID
    const states: Record<string, unknown>[] = [
      { expandedView: undefined, inbox: { messages: [] } },
      { expandedView: undefined, inbox: { messages: [] } },
    ]
    const contextFor = (index: number) => ({
      abortController: new AbortController(),
      getAppState: () => states[index],
      setAppState: (
        update: (prev: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        states[index] = update(states[index]!)
      },
    }) as unknown as ToolUseContext
    const createdNames: string[] = []
    const firstResource = new AsyncResource('concurrent-team-create-1')
    const secondResource = new AsyncResource('concurrent-team-create-2')

    try {
      let pending!: Array<ReturnType<typeof TeamCreateTool.call>>
      await withTaskListLifecycleLock('concurrent-team', async () => {
        // Both calls cross the old pre-lock existence check while the real
        // candidate lock is held. Once released, only a lock-inside recheck
        // can stop the second call from overwriting the first generation.
        pending = [
          firstResource.runInAsyncScope(() => TeamCreateTool.call({
            team_name: 'Concurrent Team',
            description: 'First independent leader',
          }, contextFor(0))),
          secondResource.runInAsyncScope(() => TeamCreateTool.call({
            team_name: 'Concurrent Team',
            description: 'Second independent leader',
          }, contextFor(1))),
        ]
      })
      const results = await Promise.all(pending)
      createdNames.push(...results.map(result => result.data.team_name))

      expect(new Set(createdNames).size).toBe(2)
      expect(createdNames).toContain('Concurrent Team')
      for (const name of createdNames) {
        const taskListId = getCanonicalTeamTaskListId(name)
        const lifecycle = await readTaskListLifecycleState(taskListId)
        expect(lifecycle).toMatchObject({
          generation: 1,
          deleted: false,
          activeIdentity: { teamName: name },
        })
        expect(getSessionCreatedTeams().get(name)).toEqual({
          generation: 1,
          identity: lifecycle.activeIdentity,
        })
        await expect(
          stat(join(configDir, 'teams', taskListId, 'config.json')),
        ).resolves.toBeDefined()
      }
    } finally {
      for (const name of createdNames) getSessionCreatedTeams().delete(name)
      clearLeaderTeamName()
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousTaskListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
      else process.env.CLAUDE_CODE_TASK_LIST_ID = previousTaskListId
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('keeps the real Team tool chain off a standalone task-list override', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'team-tool-override-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'standalone-explicit-list'
    let appState: Record<string, unknown> = {
      expandedView: undefined,
      inbox: { messages: [] },
    }
    const context = {
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: (update: (prev: Record<string, unknown>) => Record<string, unknown>) => {
        appState = update(appState)
      },
    } as unknown as ToolUseContext

    try {
      const standalone = await createTaskWithCommit('standalone-explicit-list', {
        subject: 'Standalone task survives Team cleanup',
        description: 'The Team lifecycle must never delete this list',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const created = await TeamCreateTool.call({
        team_name: 'Override Safe Team',
        description: 'Use the canonical Team DAG',
      }, context)
      const teamTask = await TaskCreateTool.call({
        subject: 'Canonical Team task',
        description: 'Must appear in the TeamDelete terminal frame',
      }, context)
      const deleted = await TeamDeleteTool.call({}, context)

      expect(deleted.data).toMatchObject({
        success: true,
        team_name: created.data.team_name,
        finalTasks: [{
          id: teamTask.data.task.id,
          subject: 'Canonical Team task',
        }],
      })
      expect(await readTaskListSnapshot('standalone-explicit-list')).toMatchObject({
        tasks: [{
          id: standalone.taskId,
          subject: 'Standalone task survives Team cleanup',
        }],
      })
    } finally {
      getSessionCreatedTeams().delete('Override Safe Team')
      clearLeaderTeamName()
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousTaskListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
      else process.env.CLAUDE_CODE_TASK_LIST_ID = previousTaskListId
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('advances the persistent task revision only for real list mutations', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'task-list-revision-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    const taskListId = 'revision-contract'

    try {
      await resetTaskList(taskListId)
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(0)
      const first = await createTaskWithCommit(taskListId, {
        subject: 'First revision task',
        description: 'Exercise mutation receipts',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const second = await createTaskWithCommit(taskListId, {
        subject: 'Second revision task',
        description: 'Exercise reciprocal edges',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      expect([first.revision, second.revision]).toEqual([1, 2])

      await updateTask(taskListId, first.taskId, {
        subject: 'First revision task',
      })
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(2)
      expect(await blockTask(taskListId, first.taskId, second.taskId)).toBe(true)
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(3)
      expect(await blockTask(taskListId, first.taskId, second.taskId)).toBe(true)
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(3)

      expect((await claimTask(taskListId, first.taskId, 'worker')).success).toBe(true)
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(4)
      expect((await claimTask(taskListId, first.taskId, 'worker')).success).toBe(true)
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(4)

      const deleted = await deleteTaskWithCommit(taskListId, first.taskId)
      expect(deleted).toMatchObject({ deleted: true, revision: 5 })
      expect((await readTaskListSnapshot(taskListId))).toMatchObject({
        revision: 5,
        tasks: [{ id: second.taskId, blockedBy: [] }],
      })
      expect(await deleteTaskWithCommit(taskListId, first.taskId)).toEqual({
        deleted: false,
      })
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(5)

      await resetTaskList(taskListId)
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(6)
      await resetTaskList(taskListId)
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(6)

      const busyTarget = await createTaskWithCommit(taskListId, {
        subject: 'Busy claim target',
        description: 'The busy claim is one transaction',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const blockedTarget = await createTaskWithCommit(taskListId, {
        subject: 'Busy claim rejection',
        description: 'A rejected claim is not a mutation',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      expect((await claimTask(
        taskListId,
        busyTarget.taskId,
        'busy-worker',
        { checkAgentBusy: true, markInProgress: true },
      )).success).toBe(true)
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(9)
      expect(await claimTask(
        taskListId,
        blockedTarget.taskId,
        'busy-worker',
        { checkAgentBusy: true, markInProgress: true },
      )).toMatchObject({ success: false, reason: 'agent_busy' })
      expect((await readTaskListSnapshot(taskListId)).revision).toBe(9)
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('fails closed on malformed lifecycle state and preserves forward fields', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'task-lifecycle-state-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    const stateDir = join(configDir, 'tasks', '.lifecycle-locks')

    try {
      await mkdir(stateDir, { recursive: true })
      await writeFile(
        join(stateDir, 'malformed.state.json'),
        JSON.stringify({ schemaVersion: 1, generation: 'bad' }),
      )
      await expect(createTaskWithCommit('malformed', {
        subject: 'Must not write through malformed state',
        description: 'Lifecycle corruption is fail-closed',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })).rejects.toThrow('Invalid task-list lifecycle state')
      await expect(stat(getTasksDir('malformed'))).rejects.toThrow()

      await writeFile(
        join(stateDir, 'forward-state.state.json'),
        JSON.stringify({
          schemaVersion: 1,
          generation: 4,
          deleted: true,
          terminals: [],
          futureField: { preserved: true },
        }),
      )
      await beginTaskListLifecycle('forward-state', {
        teamName: 'Forward State',
        createdAt: 42,
      })
      expect(await readTaskListLifecycleState('forward-state')).toMatchObject({
        generation: 5,
        deleted: false,
        futureField: { preserved: true },
      })

      await resetTaskList('empty-revision')
      await writeFile(join(getTasksDir('empty-revision'), '.revision'), '   ')
      await expect(readTaskListSnapshot('empty-revision')).rejects.toThrow(
        'Invalid empty task-list revision',
      )
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('persists causal markers and the TeamDelete terminal task frame', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'task-tool-markers-'))
    const taskListId = 'task-tool-marker-team'
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId
    let appState: Record<string, unknown> = {
      expandedView: undefined,
      inbox: { messages: [] },
    }
    const context = {
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: (update: (prev: Record<string, unknown>) => Record<string, unknown>) => {
        appState = update(appState)
      },
    } as unknown as ToolUseContext

    try {
      const created = await TaskCreateTool.call({
        subject: 'Persist causal identity',
        description: 'Archive repair must order the real task-list commits',
        activeForm: 'Persisting causal identity',
      }, context)
      const taskId = created.data.task.id
      const dependent = await TaskCreateTool.call({
        subject: 'Observe reciprocal dependency',
        description: 'The same transaction must update both task files',
        activeForm: 'Observing reciprocal dependency',
      }, context)
      const listed = await TaskListTool.call({}, context)
      const updated = await TaskUpdateTool.call({
        taskId,
        status: 'in_progress',
        addBlocks: [dependent.data.task.id],
      }, context)
      const afterUpdate = await TaskListTool.call({}, context)

      expect(Number.isFinite(Date.parse(created.data.taskListMutationAt ?? ''))).toBe(true)
      expect(Number.isFinite(Date.parse(listed.data.taskListSnapshotAt ?? ''))).toBe(true)
      expect(Number.isFinite(Date.parse(updated.data.taskListMutationAt ?? ''))).toBe(true)
      expect(created.data.taskListMutationRevision).toBe(1)
      expect(dependent.data.taskListMutationRevision).toBe(2)
      expect(listed.data.taskListSnapshotRevision).toBe(2)
      expect(updated.data.taskListMutationRevision).toBe(3)
      expect(afterUpdate.data.taskListSnapshotRevision).toBe(3)
      expect(listed.data.tasks).toHaveLength(2)
      expect(listed.data.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: taskId, status: 'pending' }),
        expect.objectContaining({ id: dependent.data.task.id, status: 'pending' }),
      ]))
      expect(afterUpdate.data.tasks).toHaveLength(2)
      expect(afterUpdate.data.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: taskId, status: 'in_progress' }),
        expect.objectContaining({
          id: dependent.data.task.id,
          blockedBy: [taskId],
        }),
      ]))

      appState = {
        ...appState,
        teamContext: { teamName: taskListId },
      }
      const deleted = await TeamDeleteTool.call({}, context)
      expect(deleted.data.finalTasks).toHaveLength(2)
      expect(deleted.data).toMatchObject({
        success: true,
        team_name: taskListId,
        finalTasks: expect.arrayContaining([
          expect.objectContaining({
            id: taskId,
            status: 'in_progress',
            blocks: [dependent.data.task.id],
          }),
          expect.objectContaining({
            id: dependent.data.task.id,
            blockedBy: [taskId],
          }),
        ]),
      })
      expect(Number.isFinite(Date.parse(deleted.data.taskListSnapshotAt ?? ''))).toBe(true)
      expect(deleted.data.taskListSnapshotRevision).toBe(3)
      await expect(stat(getTasksDir(taskListId))).rejects.toThrow()
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousTaskListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
      else process.env.CLAUDE_CODE_TASK_LIST_ID = previousTaskListId
      await rm(configDir, { recursive: true, force: true })
    }
  })
})
