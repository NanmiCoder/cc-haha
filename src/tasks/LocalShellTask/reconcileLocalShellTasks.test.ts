import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetStateForTests, switchSession } from '../../bootstrap/state.js'
import { IDLE_SPECULATION_STATE, type AppState } from '../../state/AppState.js'
import type { SessionId } from '../../types/ids.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import { readLocalShellMetadata, resetProjectForTesting, writeLocalShellMetadata } from '../../utils/sessionStorage.js'
import { LOCAL_SHELL_ERROR_MESSAGES } from './guards.js'
import { reconcileLocalShellTasks } from './reconcileLocalShellTasks.js'

const sessionId = 'local-shell-reconcile-test' as SessionId
const deadPid = 2_147_483_647

describe('reconcileLocalShellTasks', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  let configDir: string

  beforeEach(async () => {
    configDir = join(tmpdir(), `local-shell-reconcile-${crypto.randomUUID()}`)
    await mkdir(configDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
    resetStateForTests()
    switchSession(sessionId)
  })

  afterEach(async () => {
    resetProjectForTesting()
    resetStateForTests()
    await rm(configDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
  })

  test('uses terminal metadata if it wins while reconciliation is queued', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconcile-terminal-wins',
      sessionId,
      shellType: 'bash',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'running',
      lastObservedAt: 1,
      outcomeKnown: false,
    }, null)
    const originalWrite = sessionStorage.writeLocalShellMetadata
    let injected = false
    const writeSpy = spyOn(sessionStorage, 'writeLocalShellMetadata').mockImplementation(async (metadata, projectDir) => {
      if (!injected && metadata.lastKnownStatus === 'unknown') {
        injected = true
        await originalWrite({
          ...metadata,
          lastKnownStatus: 'completed',
          lastObservedAt: 2,
          terminalReason: 'command_exited',
          outcomeKnown: true,
          exitCode: 0,
        }, projectDir)
      }
      return originalWrite(metadata, projectDir)
    })
    try {
      let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
      await reconcileLocalShellTasks(updater => { state = updater(state) })
      expect(state.tasks['breconcile-terminal-wins']).toMatchObject({
        status: 'completed',
        outcomeKnown: true,
        terminalReason: 'command_exited',
        result: { code: 0 },
      })
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('terminalizes a restored running task without a sidecar', async () => {
    const staleTask = {
      id: 'blegacy-stale',
      type: 'local_bash' as const,
      status: 'running' as const,
      description: 'Legacy stale task',
      command: 'echo stale',
      startTime: 1,
      outputFile: '',
      outputOffset: 0,
      notified: false,
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    }
    let state = {
      tasks: { 'blegacy-stale': staleTask },
      speculation: IDLE_SPECULATION_STATE,
    } as AppState

    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    const task = state.tasks['blegacy-stale']
    expect(task?.status).toBe('unknown')
    expect((task as { outcomeKnown?: boolean })?.outcomeKnown).toBe(false)
    expect((task as { processObservation?: string })?.processObservation).toBe('unknown')
    expect((task as { terminalReason?: string })?.terminalReason).toBe('process_state_unverified')
  })

  test('preserves restored task identity while reconciling lifecycle fields', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'brestored-identity',
      sessionId,
      shellType: 'powershell',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'running',
      lastObservedAt: 1,
      outcomeKnown: false,
    }, null)
    const restoredTask = {
      id: 'brestored-identity',
      type: 'local_bash' as const,
      status: 'running' as const,
      description: 'Install project dependencies',
      command: 'bun install',
      startTime: 1,
      outputFile: 'existing-output',
      outputOffset: 42,
      notified: false,
      toolUseId: 'tool-use-1',
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 7,
      isBackgrounded: true,
      kind: 'bash' as const,
    }
    let state = {
      tasks: { 'brestored-identity': restoredTask },
      speculation: IDLE_SPECULATION_STATE,
    } as AppState

    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    const task = state.tasks['brestored-identity']
    expect(task).toMatchObject({
      status: 'unknown',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      description: 'Install project dependencies',
      command: 'bun install',
      outputFile: 'existing-output',
      outputOffset: 42,
      toolUseId: 'tool-use-1',
      kind: 'bash',
      shellType: 'powershell',
      processObservation: 'unknown',
    })
  })

  test('overwrites a stale running reason and retains unverified state on second recovery', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconciled-stale-reason',
      sessionId,
      shellType: 'bash',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'running',
      lastObservedAt: 1,
      terminalReason: 'termination_requested',
      error: 'old termination error',
      outcomeKnown: false,
    }, null)
    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    const setAppState = (updater: (prev: AppState) => AppState) => { state = updater(state) }

    await reconcileLocalShellTasks(setAppState)
    expect(state.tasks['breconciled-stale-reason']).toMatchObject({
      status: 'unknown',
      terminalReason: 'process_state_unverified',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      processObservation: 'unknown',
      outcomeKnown: false,
      shellCommand: null,
    })
    await expect(readLocalShellMetadata('breconciled-stale-reason', sessionId, null)).resolves.toMatchObject({
      lastKnownStatus: 'unknown',
      terminalReason: 'process_state_unverified',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      outcomeKnown: false,
    })
    state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    await reconcileLocalShellTasks(setAppState)
    expect(state.tasks['breconciled-stale-reason']).toMatchObject({
      status: 'unknown',
      terminalReason: 'process_state_unverified',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      processObservation: 'unknown',
      outcomeKnown: false,
      shellCommand: null,
    })
  })

  test('accepts legacy unknown sidecars with no terminal reason', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconciled-legacy-unknown',
      sessionId,
      shellType: 'bash',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'unknown',
      lastObservedAt: 1,
      outcomeKnown: false,
    }, null)
    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    await reconcileLocalShellTasks(updater => { state = updater(state) })
    expect(state.tasks['breconciled-legacy-unknown']).toMatchObject({
      status: 'unknown',
      terminalReason: 'process_state_unverified',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      processObservation: 'unknown',
      outcomeKnown: false,
      shellCommand: null,
    })
  })

  test('restores a disappeared process as failed without spawning a command', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconciled-dead',
      sessionId,
      shellType: 'bash',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'running',
      lastObservedAt: 1,
      outcomeKnown: false,
    }, null)

    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    const task = state.tasks['breconciled-dead']
    expect(task?.status).toBe('unknown')
    expect(task?.type).toBe('local_bash')
    expect((task as { shellCommand?: unknown })?.shellCommand).toBeNull()
    expect((task as { processObservation?: string })?.processObservation).toBe('unknown')
  })

  test('does not let stale running metadata overwrite an in-memory terminal task', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconciled-terminal',
      sessionId,
      shellType: 'bash',
      pid: process.pid,
      startTime: 1,
      lastKnownStatus: 'running',
      lastObservedAt: 1,
      outcomeKnown: false,
    }, null)

    const completedTask = {
      id: 'breconciled-terminal',
      type: 'local_bash' as const,
      status: 'completed' as const,
      description: 'Completed task',
      command: 'echo done',
      startTime: 1,
      outputFile: '',
      outputOffset: 0,
      notified: true,
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    }
    let state = {
      tasks: { 'breconciled-terminal': completedTask },
      speculation: IDLE_SPECULATION_STATE,
    } as AppState
    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    expect(state.tasks['breconciled-terminal']).toBe(completedTask)
    expect(state.tasks['breconciled-terminal']?.status).toBe('completed')
  })

  test('writes unknown recovery state back to a non-default session directory', async () => {
    const projectDir = join(configDir, 'other-project')
    await mkdir(projectDir, { recursive: true })
    switchSession(sessionId, projectDir)
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'brestored-project-dir',
      sessionId,
      shellType: 'bash',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'running',
      lastObservedAt: 1,
      outcomeKnown: false,
    }, projectDir)

    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    await expect(readLocalShellMetadata('brestored-project-dir', sessionId, projectDir)).resolves.toMatchObject({
      lastKnownStatus: 'unknown',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
    })
  })

  test('does not attach to a live pid without a process identity match', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconciled-live-unverified',
      sessionId,
      shellType: 'bash',
      pid: process.pid,
      startTime: 1,
      lastKnownStatus: 'running',
      lastObservedAt: 1,
      outcomeKnown: false,
    }, null)

    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    const task = state.tasks['breconciled-live-unverified']
    expect(task?.status).toBe('unknown')
    expect((task as { processObservation?: string })?.processObservation).toBe('unknown')
    expect((task as { shellCommand?: unknown })?.shellCommand).toBeNull()
  })

  test('preserves unknown killed metadata without probing its stale live pid', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconciled-killed-unknown',
      sessionId,
      shellType: 'bash',
      pid: process.pid,
      startTime: 1,
      lastKnownStatus: 'killed',
      lastObservedAt: 2,
      terminalReason: 'termination_confirmed',
      outcomeKnown: false,
    }, null)

    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    const task = state.tasks['breconciled-killed-unknown']
    expect(task?.status).toBe('killed')
    expect((task as { outcomeKnown?: boolean })?.outcomeKnown).toBe(false)
    expect((task as { terminalReason?: string })?.terminalReason).toBe('termination_confirmed')
    expect((task as { processObservation?: string })?.processObservation).toBeUndefined()
    expect((task as { result?: unknown })?.result).toBeUndefined()
  })

  test('preserves unknown failed metadata without probing its stale live pid', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconciled-failed-unknown',
      sessionId,
      shellType: 'bash',
      pid: process.pid,
      startTime: 1,
      lastKnownStatus: 'failed',
      lastObservedAt: 2,
      terminalReason: 'process_disappeared',
      outcomeKnown: false,
    }, null)

    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    const task = state.tasks['breconciled-failed-unknown']
    expect(task?.status).toBe('failed')
    expect((task as { outcomeKnown?: boolean })?.outcomeKnown).toBe(false)
    expect((task as { terminalReason?: string })?.terminalReason).toBe('process_disappeared')
    expect((task as { processObservation?: string })?.processObservation).toBeUndefined()
    expect((task as { result?: unknown })?.result).toBeUndefined()
  })

  test('stops applying recovered tasks after the active session changes', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'bsession-switch-a',
      sessionId,
      shellType: 'bash',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'completed',
      lastObservedAt: 2,
      outcomeKnown: true,
      exitCode: 0,
    }, null)
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'bsession-switch-b',
      sessionId,
      shellType: 'bash',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'completed',
      lastObservedAt: 2,
      outcomeKnown: true,
      exitCode: 0,
    }, null)
    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    let updates = 0

    await reconcileLocalShellTasks(updater => {
      state = updater(state)
      updates++
      if (updates === 2) switchSession('local-shell-reconcile-next' as SessionId)
    })

    expect(Object.keys(state.tasks)).toHaveLength(1)
  })

  test('does not apply same-ID metadata after switching project directories during reconciliation', async () => {
    const firstDir = join(configDir, 'project-a')
    const secondDir = join(configDir, 'project-b')
    await mkdir(firstDir, { recursive: true })
    await mkdir(secondDir, { recursive: true })
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'bsame-id',
      sessionId,
      shellType: 'bash',
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'completed',
      lastObservedAt: 2,
      terminalReason: 'command_exited',
      outcomeKnown: true,
      exitCode: 0,
    }, firstDir)
    switchSession(sessionId, firstDir)
    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState

    const pending = reconcileLocalShellTasks(updater => { state = updater(state) })
    switchSession(sessionId, secondDir)
    await pending

    expect(state.tasks['bsame-id']).toBeUndefined()
  })

  test('does not write a recovered sidecar after project switch during state update', async () => {
    const firstDir = join(configDir, 'write-project-a')
    const secondDir = join(configDir, 'write-project-b')
    await mkdir(firstDir, { recursive: true })
    await mkdir(secondDir, { recursive: true })
    const running = {
      schemaVersion: 1 as const,
      taskId: 'bsame-write-id',
      sessionId,
      shellType: 'bash' as const,
      pid: deadPid,
      startTime: 1,
      lastKnownStatus: 'running' as const,
      lastObservedAt: 1,
      outcomeKnown: false,
    }
    await writeLocalShellMetadata(running, firstDir)
    await writeLocalShellMetadata({
      ...running,
      lastKnownStatus: 'completed',
      terminalReason: 'command_exited',
      outcomeKnown: true,
      exitCode: 0,
    }, secondDir)
    switchSession(sessionId, firstDir)
    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    let updates = 0

    await reconcileLocalShellTasks(updater => {
      state = updater(state)
      if (++updates === 1) switchSession(sessionId, secondDir)
    })

    await expect(readLocalShellMetadata('bsame-write-id', sessionId, firstDir)).resolves.toMatchObject({
      lastKnownStatus: 'running',
    })
    await expect(readLocalShellMetadata('bsame-write-id', sessionId, secondDir)).resolves.toMatchObject({
      lastKnownStatus: 'completed',
      terminalReason: 'command_exited',
    })
  })

  test('preserves a persisted terminal outcome without probing its stale pid', async () => {
    await writeLocalShellMetadata({
      schemaVersion: 1,
      taskId: 'breconciled-completed',
      sessionId,
      shellType: 'powershell',
      pid: process.pid,
      startTime: 1,
      lastKnownStatus: 'completed',
      lastObservedAt: 2,
      terminalReason: 'command_exited',
      outcomeKnown: true,
      exitCode: 0,
    }, null)

    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    await reconcileLocalShellTasks(updater => {
      state = updater(state)
    })

    const task = state.tasks['breconciled-completed']
    expect(task?.status).toBe('completed')
    expect((task as { processObservation?: string })?.processObservation).toBeUndefined()
    expect((task as { outcomeKnown?: boolean })?.outcomeKnown).toBe(true)
    expect((task as { shellType?: string })?.shellType).toBe('powershell')
  })
})
