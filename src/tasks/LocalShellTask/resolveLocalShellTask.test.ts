import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { switchSession } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { SessionId } from '../../types/ids.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import { readLocalShellMetadata, resetProjectForTesting, writeLocalShellMetadata } from '../../utils/sessionStorage.js'
import { LOCAL_SHELL_ERROR_MESSAGES } from './guards.js'
import { resolveLocalShellTask } from './resolveLocalShellTask.js'

const sessionId = 'local-shell-resolver-test' as SessionId
const deadPid = 2_147_483_647

function metadata() {
  return {
    schemaVersion: 1 as const,
    taskId: 'bresolver-test',
    sessionId,
    shellType: 'bash' as const,
    pid: deadPid,
    startTime: 1,
    lastKnownStatus: 'running' as const,
    lastObservedAt: 1,
    outcomeKnown: false,
  }
}

describe('resolveLocalShellTask', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  let configDir: string

  beforeEach(async () => {
    configDir = join(tmpdir(), `local-shell-resolver-${crypto.randomUUID()}`)
    await mkdir(configDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
    switchSession(sessionId)
  })

  afterEach(async () => {
    resetProjectForTesting()
    await rm(configDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
  })

  test('returns the live task without probing persisted metadata', async () => {
    const liveTask = {
      id: 'blive-test',
      type: 'local_bash' as const,
      status: 'running' as const,
      description: 'live',
      command: 'echo live',
      startTime: 1,
      outputFile: '',
      outputOffset: 0,
      notified: false,
      completionStatusSentInAttachment: false,
      shellCommand: {},
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    }
    const state = { tasks: { 'blive-test': liveTask } } as unknown as AppState

    const resolved = await resolveLocalShellTask('blive-test', () => state)
    expect(resolved?.task).toBe(liveTask)
    expect(resolved?.canStop).toBe(true)
  })

  test('uses terminal metadata if it wins while recovery is queued', async () => {
    await writeLocalShellMetadata(metadata(), null)
    const originalRead = sessionStorage.readLocalShellMetadata
    let reads = 0
    const readSpy = spyOn(sessionStorage, 'readLocalShellMetadata').mockImplementation(async (...args) => {
      const result = await originalRead(...args)
      if (++reads === 1) {
        await writeLocalShellMetadata({
          ...metadata(),
          lastKnownStatus: 'completed',
          terminalReason: 'command_exited',
          outcomeKnown: true,
          exitCode: 0,
          lastObservedAt: 2,
        }, null)
      }
      return result
    })
    try {
      const resolved = await resolveLocalShellTask('bresolver-test', () => ({ tasks: {} }) as AppState)
      expect(resolved?.task).toMatchObject({
        status: 'completed',
        outcomeKnown: true,
        terminalReason: 'command_exited',
        result: { code: 0 },
      })
    } finally {
      readSpy.mockRestore()
    }
  })

  test('returns a synthetic failed task for stale running state without metadata', async () => {
    const staleTask = {
      id: 'bresolver-legacy',
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
    const state = { tasks: { 'bresolver-legacy': staleTask } } as AppState

    const resolved = await resolveLocalShellTask('bresolver-legacy', () => state)

    expect(resolved?.task.status).toBe('unknown')
    expect((resolved?.task as { outcomeKnown?: boolean }).outcomeKnown).toBe(false)
    expect(resolved?.processObservation).toBe('unknown')
    expect(resolved?.canStop).toBe(false)
  })

  test('marks a persisted running process as unknown after session reopen', async () => {
    await writeLocalShellMetadata({ ...metadata(), pid: process.pid }, null)
    const state = { tasks: {} } as AppState

    const resolved = await resolveLocalShellTask('bresolver-test', () => state)
    expect(resolved?.processObservation).toBe('unknown')
    expect(resolved?.task.status).toBe('unknown')
    expect(resolved?.task.error).toBe(LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown)
    expect(resolved?.task.endTime).toBeDefined()
    expect(resolved?.canStop).toBe(false)
    expect(resolved?.task).toMatchObject({
      terminalReason: 'process_state_unverified',
      processObservation: 'unknown',
      outcomeKnown: false,
      shellCommand: null,
    })
  })

  test('overwrites a stale running reason on disk and retains unknown observation after reopening', async () => {
    await writeLocalShellMetadata({
      ...metadata(),
      terminalReason: 'termination_requested',
      error: 'old termination error',
    }, null)
    const state = { tasks: {} } as AppState

    const first = await resolveLocalShellTask('bresolver-test', () => state)
    expect(first?.task).toMatchObject({
      status: 'unknown',
      terminalReason: 'process_state_unverified',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      processObservation: 'unknown',
      outcomeKnown: false,
      shellCommand: null,
    })
    expect(first?.processObservation).toBe('unknown')
    await expect(readLocalShellMetadata('bresolver-test', sessionId, null)).resolves.toMatchObject({
      lastKnownStatus: 'unknown',
      terminalReason: 'process_state_unverified',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      outcomeKnown: false,
    })

    const second = await resolveLocalShellTask('bresolver-test', () => state)
    expect(second?.task).toMatchObject({
      status: 'unknown',
      terminalReason: 'process_state_unverified',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      processObservation: 'unknown',
      outcomeKnown: false,
      shellCommand: null,
    })
    expect(second?.processObservation).toBe('unknown')
    expect(second?.canStop).toBe(false)
  })

  test('recovers legacy unknown sidecars without lifecycle fields as unverified', async () => {
    await writeLocalShellMetadata({
      ...metadata(),
      lastKnownStatus: 'unknown',
      error: 'old error',
    }, null)
    const resolved = await resolveLocalShellTask('bresolver-test', () => ({ tasks: {} }) as AppState)
    expect(resolved?.task).toMatchObject({
      status: 'unknown',
      error: LOCAL_SHELL_ERROR_MESSAGES.processStateUnknown,
      terminalReason: 'process_state_unverified',
      processObservation: 'unknown',
      outcomeKnown: false,
      shellCommand: null,
    })
    expect(resolved?.processObservation).toBe('unknown')
    expect(resolved?.canStop).toBe(false)
  })

  test('recovers persisted output as read-only when process identity is unavailable', async () => {
    await writeLocalShellMetadata(metadata(), null)
    const state = { tasks: {} } as AppState

    const resolved = await resolveLocalShellTask('bresolver-test', () => state)
    expect(resolved?.metadata?.taskId).toBe('bresolver-test')
    expect(resolved?.processObservation).toBe('unknown')
    expect(resolved?.canStop).toBe(false)
    expect(resolved?.task.status).toBe('unknown')
  })

  test('preserves a persisted terminal outcome without probing its stale pid', async () => {
    await writeLocalShellMetadata({
      ...metadata(),
      taskId: 'bresolver-completed',
      pid: process.pid,
      lastKnownStatus: 'completed',
      terminalReason: 'command_exited',
      outcomeKnown: true,
      exitCode: 0,
    }, null)
    const state = { tasks: {} } as AppState

    const resolved = await resolveLocalShellTask('bresolver-completed', () => state)
    expect(resolved?.task.status).toBe('completed')
    expect(resolved?.processObservation).toBeUndefined()
    expect(resolved?.canStop).toBe(false)
    expect((resolved?.task as { outcomeKnown?: boolean })?.outcomeKnown).toBe(true)
  })

  test('preserves known failed and killed terminal outcomes', async () => {
    await writeLocalShellMetadata({
      ...metadata(),
      taskId: 'bresolver-failed-known',
      lastKnownStatus: 'failed',
      terminalReason: 'command_exited',
      outcomeKnown: true,
      exitCode: 7,
    }, null)
    await writeLocalShellMetadata({
      ...metadata(),
      taskId: 'bresolver-killed-known',
      lastKnownStatus: 'killed',
      terminalReason: 'termination_confirmed',
      outcomeKnown: true,
      exitCode: 137,
    }, null)
    const state = { tasks: {} } as AppState

    const failed = await resolveLocalShellTask('bresolver-failed-known', () => state)
    expect(failed?.task.status).toBe('failed')
    expect((failed?.task as { result?: { code: number } }).result?.code).toBe(7)
    const killed = await resolveLocalShellTask('bresolver-killed-known', () => state)
    expect(killed?.task.status).toBe('killed')
    expect((killed?.task as { result?: { code: number } }).result?.code).toBe(137)
  })

  test('preserves an unknown killed terminal outcome without probing its stale pid', async () => {
    await writeLocalShellMetadata({
      ...metadata(),
      taskId: 'bresolver-killed-unknown',
      pid: process.pid,
      lastKnownStatus: 'killed',
      terminalReason: 'termination_confirmed',
      outcomeKnown: false,
    }, null)
    const state = { tasks: {} } as AppState

    const resolved = await resolveLocalShellTask('bresolver-killed-unknown', () => state)
    expect(resolved?.task.status).toBe('killed')
    expect(resolved?.processObservation).toBeUndefined()
    expect(resolved?.canStop).toBe(false)
    expect((resolved?.task as { outcomeKnown?: boolean }).outcomeKnown).toBe(false)
    expect((resolved?.task as { terminalReason?: string }).terminalReason).toBe('termination_confirmed')
    expect((resolved?.task as { result?: unknown }).result).toBeUndefined()
  })

  test('preserves an unknown failed terminal outcome without probing its stale pid', async () => {
    await writeLocalShellMetadata({
      ...metadata(),
      taskId: 'bresolver-failed-unknown',
      pid: process.pid,
      lastKnownStatus: 'failed',
      terminalReason: 'process_disappeared',
      outcomeKnown: false,
    }, null)
    const state = { tasks: {} } as AppState

    const resolved = await resolveLocalShellTask('bresolver-failed-unknown', () => state)
    expect(resolved?.task.status).toBe('failed')
    expect(resolved?.processObservation).toBeUndefined()
    expect(resolved?.canStop).toBe(false)
    expect((resolved?.task as { outcomeKnown?: boolean }).outcomeKnown).toBe(false)
    expect((resolved?.task as { terminalReason?: string }).terminalReason).toBe('process_disappeared')
    expect((resolved?.task as { result?: unknown }).result).toBeUndefined()
  })

  test('does not return or write an old session result after an asynchronous session switch', async () => {
    const nextSession = 'local-shell-resolver-next' as SessionId
    const oldProjectDir = join(configDir, 'switch-project')
    await mkdir(oldProjectDir, { recursive: true })
    switchSession(sessionId, oldProjectDir)
    await writeLocalShellMetadata(metadata(), oldProjectDir)
    const state = { tasks: {} } as AppState

    const pending = resolveLocalShellTask('bresolver-test', () => state)
    switchSession(nextSession)

    await expect(pending).resolves.toBeNull()
    await expect(readLocalShellMetadata('bresolver-test', sessionId, oldProjectDir)).resolves.toMatchObject({
      lastKnownStatus: 'running',
    })
  })

  test('does not return the same task ID from another project directory after a switch', async () => {
    const firstDir = join(configDir, 'project-a')
    const secondDir = join(configDir, 'project-b')
    await mkdir(firstDir, { recursive: true })
    await mkdir(secondDir, { recursive: true })
    await writeLocalShellMetadata({ ...metadata(), terminalReason: 'termination_requested' }, firstDir)
    await writeLocalShellMetadata({
      ...metadata(),
      lastKnownStatus: 'completed',
      terminalReason: 'command_exited',
      outcomeKnown: true,
      exitCode: 0,
    }, secondDir)
    switchSession(sessionId, firstDir)
    const state = { tasks: {} } as AppState

    const pending = resolveLocalShellTask('bresolver-test', () => state)
    switchSession(sessionId, secondDir)

    await expect(pending).resolves.toBeNull()
    await expect(readLocalShellMetadata('bresolver-test', sessionId, firstDir)).resolves.toMatchObject({
      lastKnownStatus: 'running',
    })
    await expect(readLocalShellMetadata('bresolver-test', sessionId, secondDir)).resolves.toMatchObject({
      lastKnownStatus: 'completed',
      terminalReason: 'command_exited',
    })
  })

  test('returns null when neither in-memory nor persisted task exists', async () => {
    const state = { tasks: {} } as AppState
    await expect(resolveLocalShellTask('bmissing-test', () => state)).resolves.toBeNull()
  })
})
