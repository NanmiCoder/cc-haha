import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppState } from '../../state/AppState.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { flushLocalShellMetadataWritesForTesting, readLocalShellMetadata, resetProjectForTesting } from '../../utils/sessionStorage.js'
import { createLocalShellFinalization, settleLocalShellFinalization } from './guards.js'
import { killTask } from './killShellTasks.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  resetProjectForTesting()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function harnessFor(
  command: ShellCommand,
  status: 'running' | 'completed' = 'running',
  taskId = 'bkill-test',
  ownership?: { sessionId: string; projectDir: string },
) {
  let state = {
    tasks: {
      [taskId]: {
        id: 'bkill-test',
        type: 'local_bash',
        status,
        description: 'Kill task',
        command: 'sleep 10',
        startTime: 1,
        outputFile: command.taskOutput.path,
        outputOffset: 0,
        notified: false,
        completionStatusSentInAttachment: false,
        shellCommand: command,
        lastReportedTotalLines: 0,
        isBackgrounded: true,
        sessionId: ownership?.sessionId,
        projectDir: ownership?.projectDir,
        shellType: 'bash',
      },
    },
  } as unknown as AppState
  return {
    get state() {
      return state
    },
    setAppState(updater: (previous: AppState) => AppState) {
      state = updater(state)
    },
  }
}

function command(overrides: Partial<ShellCommand> = {}): ShellCommand {
  const waitForExit = overrides.waitForExit ?? (async () => true)
  return {
    background: () => false,
    result: Promise.resolve({ stdout: '', stderr: '', code: 137, interrupted: true }),
    kill: () => {},
    async terminateAndWait(timeoutMs) {
      this.kill()
      const exited = await waitForExit(timeoutMs)
      return exited && this.status === 'killed'
    },
    terminationConfirmed: true,
    confirmProcessDisappeared: () => true,
    waitForExit: async () => true,
    status: 'killed',
    pid: 1234,
    terminationRequested: true,
    processExited: true,
    cleanup: () => {},
    taskOutput: new TaskOutput('bkill-test', null, false),
    ...overrides,
  }
}

describe('killTask', () => {
  test('returns false when the task is already terminal', async () => {
    const harness = harnessFor(command(), 'completed')

    expect(await killTask('bkill-test', harness.setAppState)).toBe(false)
    expect(harness.state.tasks['bkill-test']?.status).toBe('completed')
  })

  test('leaves a running task without a controllable process unchanged', async () => {
    const taskId = 'bkill-no-handle'
    const harness = harnessFor(command(), 'running', taskId)
    harness.setAppState(previous => ({
      ...previous,
      tasks: {
        ...previous.tasks,
        [taskId]: {
          ...previous.tasks[taskId]!,
          shellCommand: null,
          terminationRequested: undefined,
          terminationPending: undefined,
          terminationSource: undefined,
          terminalReason: undefined,
        },
      },
    }))

    expect(await killTask(taskId, harness.setAppState)).toBe(false)
    expect(harness.state.tasks[taskId]).toMatchObject({
      status: 'running',
      shellCommand: null,
      terminationRequested: undefined,
      terminationPending: undefined,
      terminationSource: undefined,
      terminalReason: undefined,
    })
  })

  test('persists a disappeared task without inventing an exit code', async () => {
    const projectDir = join(tmpdir(), `local-shell-kill-${crypto.randomUUID()}`)
    temporaryDirectories.push(projectDir)
    await mkdir(projectDir, { recursive: true })
    const taskId = 'bkill-persisted'
    const taskOutput = new TaskOutput(taskId, null, false)
    const harness = harnessFor(command({ taskOutput }), 'running', taskId, {
      sessionId: 'kill-session',
      projectDir,
    })

    expect(await killTask(taskId, harness.setAppState)).toBe(false)
    await flushLocalShellMetadataWritesForTesting()
    await expect(readLocalShellMetadata(taskId, 'kill-session', projectDir)).resolves.toMatchObject({
      lastKnownStatus: 'failed',
      outcomeKnown: false,
    })
  })

  test('终止抛错且进程已消失时释放注册和命令资源', async () => {
    let unregistered = 0
    let cleaned = 0
    const harness = harnessFor(command({
      kill: () => { throw new Error('access denied') },
      cleanup: () => { cleaned += 1 },
    }))
    harness.setAppState(previous => ({
      ...previous,
      tasks: {
        ...previous.tasks,
        'bkill-test': { ...previous.tasks['bkill-test']!, unregisterCleanup: () => { unregistered += 1 } },
      },
    }))
    expect(await killTask('bkill-test', harness.setAppState)).toBe(false)
    expect(unregistered).toBe(1)
    expect(cleaned).toBe(1)
    expect(harness.state.tasks['bkill-test']).toMatchObject({ status: 'failed', shellCommand: null, terminationPending: false })
  })

  test('reports a termination request failure and marks a disappeared task failed', async () => {
    const harness = harnessFor(command({
      kill: () => {
        throw new Error('kill failed')
      },
    }))

    expect(await killTask('bkill-test', harness.setAppState)).toBe(false)
    expect(harness.state.tasks['bkill-test']?.status).toBe('failed')
    expect(harness.state.tasks['bkill-test']?.error).toBe('User termination failed.')
    expect(harness.state.tasks['bkill-test']?.terminationPending).toBe(false)
    expect(harness.state.tasks['bkill-test']?.terminationSource).toBeUndefined()
    expect((harness.state.tasks['bkill-test'] as { terminalReason?: string }).terminalReason).toBe('termination_request_failed')
  })

  test('ignores a duplicate termination request while one is pending', async () => {
    const harness = harnessFor(command())
    harness.setAppState(previous => ({
      ...previous,
      tasks: {
        ...previous.tasks,
        'bkill-test': {
          ...previous.tasks['bkill-test']!,
          terminationPending: true,
        },
      },
    }))

    expect(await killTask('bkill-test', harness.setAppState)).toBe(false)
  })

  test('sends the termination request outside the state updater', async () => {
    let insideUpdater = false
    const harness = harnessFor(command({
      kill: () => {
        expect(insideUpdater).toBe(false)
        harness.setAppState(previous => ({
          ...previous,
          tasks: {
            ...previous.tasks,
            'bkill-test': { ...previous.tasks['bkill-test']!, status: 'killed' },
          },
        }))
      },
    }))
    const setAppState = (updater: (previous: AppState) => AppState) => {
      insideUpdater = true
      try {
        harness.setAppState(updater)
      } finally {
        insideUpdater = false
      }
    }
    createLocalShellFinalization('bkill-test')
    queueMicrotask(() => settleLocalShellFinalization('bkill-test'))

    expect(await killTask('bkill-test', setAppState)).toBe(true)
  })

  test('records a timeout when the child does not exit', async () => {
    const taskId = 'bkill-timeout'
    const timeoutHarness = harnessFor(command({
      taskOutput: new TaskOutput(taskId, null, false),
      waitForExit: async () => false,
      processExited: false,
      status: 'running',
    }), 'running', taskId)
    createLocalShellFinalization(taskId)
    expect(await killTask(taskId, timeoutHarness.setAppState)).toBe(false)
    expect(timeoutHarness.state.tasks[taskId]?.error).toBe('User termination failed.')
    expect(timeoutHarness.state.tasks[taskId]?.terminationPending).toBe(false)
    expect((timeoutHarness.state.tasks[taskId] as { terminalReason?: string }).terminalReason).toBe('termination_timeout')
  })

  test('does not overwrite a terminal state committed while waiting', async () => {
    const shellCommand = command({
      waitForExit: async () => {
        harness.setAppState(previous => ({
          ...previous,
          tasks: {
            ...previous.tasks,
            'bkill-test': {
              ...previous.tasks['bkill-test']!,
              status: 'completed',
            },
          },
        }))
        return true
      },
    })
    const harness = harnessFor(shellCommand)
    createLocalShellFinalization('bkill-test')
    queueMicrotask(() => settleLocalShellFinalization('bkill-test'))

    expect(await killTask('bkill-test', harness.setAppState)).toBe(false)
    expect(harness.state.tasks['bkill-test']?.status).toBe('completed')
  })
})
