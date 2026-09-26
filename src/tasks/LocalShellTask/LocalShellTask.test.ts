import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppState } from '../../state/AppState.js'
import type { ExecResult, ShellCommand } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { getOriginalCwd, resetStateForTests, setIsInteractive, switchSession } from '../../bootstrap/state.js'
import {
  flushLocalShellMetadataWritesForTesting,
  readLocalShellMetadata,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppState.js'
import type { SessionId } from '../../types/ids.js'
import {
  backgroundAll,
  backgroundExistingForegroundTask,
  markTaskNotified,
  reconcileRunningLocalShellTask,
  registerForeground,
  spawnShellTask,
} from './LocalShellTask.js'
import { killTask } from './killShellTasks.js'

function createCommand(
  taskId: string,
  code: number,
  status: ShellCommand['status'],
  result: Promise<ExecResult> = Promise.resolve({ stdout: '', stderr: '', code, interrupted: false }),
): ShellCommand {
  const taskOutput = new TaskOutput(taskId, null, false)
  return {
    background: () => true,
    result,
    kill: () => {},
    async terminateAndWait(timeoutMs) {
      this.kill()
      return await this.waitForExit(timeoutMs) && this.status === 'killed'
    },
    terminationConfirmed: status === 'killed',
    waitForExit: async () => true,
    status,
    pid: 1234,
    terminationRequested: status === 'killed',
    processExited: true,
    confirmProcessDisappeared: () => false,
    cleanup: () => {},
    taskOutput,
  }
}

function createHarness() {
  let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
  return {
    get state() {
      return state
    },
    setAppState(updater: (previous: AppState) => AppState) {
      state = updater(state)
    },
  }
}

async function waitForTaskStatus(harness: ReturnType<typeof createHarness>, taskId: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const status = harness.state.tasks[taskId]?.status
    if (status !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return harness.state.tasks[taskId]?.status
}

describe('spawnShellTask finalization', () => {
  let projectDir: string

  beforeEach(() => {
    resetStateForTests()
    setIsInteractive(false)
    projectDir = join(tmpdir(), `local-shell-task-${crypto.randomUUID()}`)
    switchSession('local-shell-task-test' as SessionId, projectDir)
  })

  afterEach(async () => {
    await flushLocalShellMetadataWritesForTesting()
    resetProjectForTesting()
    resetStateForTests()
    await rm(projectDir, { recursive: true, force: true })
  })

  test('marks a successful command completed after its result resolves', async () => {
    const harness = createHarness()
    const command = createCommand('btask-completed', 0, 'completed')

    const handle = await spawnShellTask({
      command: 'echo complete',
      description: 'Complete command',
      shellCommand: command,
      shellType: 'bash',
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await waitForTaskStatus(harness, handle.taskId)).toBe('completed')
    expect(harness.state.tasks[handle.taskId]?.shellCommand).toBeNull()
  })

  test('writes terminal metadata to the null project snapshot after switching projects', async () => {
    const harness = createHarness()
    const taskId = `bnull-finalize-${crypto.randomUUID()}`
    const originalProjectDir = getOriginalCwd()
    const switchedProjectDir = join(tmpdir(), `local-shell-switched-${crypto.randomUUID()}`)
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => { resolveResult = resolve })
    const command = createCommand(taskId, 0, 'completed', result)

    switchSession('local-shell-task-test' as SessionId, null)
    const handle = await spawnShellTask({ command: 'echo done', description: 'Null snapshot', shellCommand: command }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })
    expect(harness.state.tasks[handle.taskId]?.projectDir).toBeNull()
    await mkdir(switchedProjectDir, { recursive: true })
    switchSession('local-shell-task-test' as SessionId, switchedProjectDir)
    resolveResult({ stdout: '', stderr: '', code: 0, interrupted: false })

    expect(await waitForTaskStatus(harness, handle.taskId)).toBe('completed')
    await flushLocalShellMetadataWritesForTesting()
    await expect(readLocalShellMetadata(taskId, 'local-shell-task-test', null)).resolves.toMatchObject({
      lastKnownStatus: 'completed',
      exitCode: 0,
    })
    await expect(readLocalShellMetadata(taskId, 'local-shell-task-test', switchedProjectDir)).resolves.toBeNull()
    await rm(switchedProjectDir, { recursive: true, force: true })
    expect(originalProjectDir).toBeDefined()
  })

  test('marks a nonzero command failed', async () => {
    const harness = createHarness()
    const command = createCommand('btask-failed', 7, 'completed')

    const handle = await spawnShellTask({
      command: 'exit 7',
      description: 'Fail command',
      shellCommand: command,
      shellType: 'powershell',
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await waitForTaskStatus(harness, handle.taskId)).toBe('failed')
    expect(harness.state.tasks[handle.taskId]?.shellType).toBe('powershell')
  })

  test('cancels the direct-background stall watchdog after completion', async () => {
    const harness = createHarness()
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval')
    const command = createCommand('bstall-watchdog', 0, 'completed')

    const handle = await spawnShellTask({
      command: 'echo done',
      description: 'Watchdog command',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await waitForTaskStatus(harness, handle.taskId)).toBe('completed')
    expect(clearIntervalSpy).toHaveBeenCalled()
    clearIntervalSpy.mockRestore()
  })

  test('commits terminal state and metadata before async output flush completes', async () => {
    const harness = createHarness()
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    let releaseFlush!: () => void
    const flushGate = new Promise<void>(resolve => {
      releaseFlush = resolve
    })
    const command = createCommand('bterminal-before-flush', 0, 'completed', result)
    command.taskOutput.flush = async () => flushGate

    const handle = await spawnShellTask({
      command: 'echo natural',
      description: 'Natural exit',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    resolveResult({ stdout: '', stderr: '', code: 0, interrupted: false })
    const status = await waitForTaskStatus(harness, handle.taskId)
    let metadata = await readLocalShellMetadata(handle.taskId, 'local-shell-task-test', projectDir)
    for (let attempt = 0; metadata?.lastKnownStatus !== 'completed' && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      metadata = await readLocalShellMetadata(handle.taskId, 'local-shell-task-test', projectDir)
    }
    const notifications = dequeueAllMatching(notification =>
      notification.value.includes(handle.taskId),
    )
    expect(metadata).toMatchObject({
      lastKnownStatus: 'completed',
      outcomeKnown: true,
      exitCode: 0,
    })
    expect(notifications).toHaveLength(1)
    releaseFlush()
    expect(status).toBe('completed')
    expect(harness.state.tasks[handle.taskId]?.result?.code).toBe(0)
  })

  test('returns from stop while output flush remains pending', async () => {
    const harness = createHarness()
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    let releaseFlush!: () => void
    const flushGate = new Promise<void>(resolve => {
      releaseFlush = resolve
    })
    const command = createCommand('bstop-before-flush', 137, 'killed', result)
    command.kill = () => {
      resolveResult({ stdout: '', stderr: '', code: 137, interrupted: true })
    }
    command.taskOutput.flush = async () => flushGate

    const handle = await spawnShellTask({
      command: 'sleep 10',
      description: 'Stop before flush',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    const stopResult = await Promise.race([
      killTask(handle.taskId, harness.setAppState),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 100)),
    ])
    expect(stopResult).toBe(true)
    expect(harness.state.tasks[handle.taskId]?.status).toBe('killed')
    expect(dequeueAllMatching(notification =>
      notification.value.includes(handle.taskId),
    )).toHaveLength(0)
    releaseFlush()
  })

  test('reports a successful stop after a terminal metadata write fails', async () => {
    const harness = createHarness()
    const projectFile = join(tmpdir(), `local-shell-project-${crypto.randomUUID()}`)
    await writeFile(projectFile, 'not a directory')
    switchSession('local-shell-task-failure' as SessionId, projectFile)
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand('bfinalization-failure', 137, 'killed', result)
    command.kill = () => {
      resolveResult({ stdout: '', stderr: '', code: 137, interrupted: true })
    }
    const handle = await spawnShellTask({
      command: 'sleep 10',
      description: 'Durability failure',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await killTask(handle.taskId, harness.setAppState)).toBe(true)
    expect(harness.state.tasks[handle.taskId]?.status).toBe('killed')
    expect(harness.state.tasks[handle.taskId]?.shellCommand).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 20))
    await rm(projectFile, { force: true })
  })

  test('reports a successful stop after output flush fails', async () => {
    const harness = createHarness()
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand('bflush-failure', 137, 'killed', result)
    command.kill = () => {
      resolveResult({ stdout: '', stderr: '', code: 137, interrupted: true })
    }
    command.taskOutput.flush = async () => {
      throw new Error('flush failed')
    }
    const handle = await spawnShellTask({
      command: 'sleep 10',
      description: 'Flush failure',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await killTask(handle.taskId, harness.setAppState)).toBe(true)
    expect(harness.state.tasks[handle.taskId]?.status).toBe('killed')
    expect(harness.state.tasks[handle.taskId]?.shellCommand).toBeNull()
  })

  test('cleanup callback failure still settles the finalization barrier', async () => {
    const harness = createHarness()
    const command = createCommand('bcleanup-failure', 137, 'killed')
    const taskId = registerForeground({
      command: 'sleep 10',
      description: 'Cleanup failure',
      shellCommand: command,
    }, harness.setAppState)
    const task = harness.state.tasks[taskId]
    if (task?.type === 'local_bash') {
      task.unregisterCleanup = () => {
        throw new Error('cleanup failed')
      }
    }

    expect(await killTask(taskId, harness.setAppState, 'user')).toBe(true)
    expect(harness.state.tasks[taskId]?.status).toBe('killed')
    expect(harness.state.tasks[taskId]?.error).toBe('User termination confirmed.')
    expect(harness.state.tasks[taskId]?.shellCommand).toBeNull()
  })

  test('foreground stop waits for its pre-registered finalization', async () => {
    const harness = createHarness()
    const command = createCommand('bforeground-stop', 137, 'killed')
    const taskId = registerForeground({
      command: 'sleep 10',
      description: 'Foreground stop',
      shellCommand: command,
    }, harness.setAppState)

    expect(await killTask(taskId, harness.setAppState, 'agent')).toBe(true)
    expect(harness.state.tasks[taskId]?.status).toBe('killed')
    expect(harness.state.tasks[taskId]?.error).toBe('Agent termination confirmed.')
  })

  test('preserves a natural completion when termination races with exit', async () => {
    const harness = createHarness()
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand('bnatural-race', 0, 'completed', result)
    command.kill = () => resolveResult({ stdout: '', stderr: '', code: 0, interrupted: false })

    const handle = await spawnShellTask({
      command: 'echo race',
      description: 'Natural race',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await killTask(handle.taskId, harness.setAppState, 'user')).toBe(false)
    expect(harness.state.tasks[handle.taskId]?.status).toBe('completed')
    expect(harness.state.tasks[handle.taskId]?.error).toBe('User termination failed.')
  })

  test('preserves a natural failure when termination races with exit', async () => {
    const harness = createHarness()
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand('bnatural-failure-race', 7, 'completed', result)
    command.kill = () => resolveResult({ stdout: '', stderr: '', code: 7, interrupted: false })

    const handle = await spawnShellTask({
      command: 'exit 7',
      description: 'Natural failure race',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await killTask(handle.taskId, harness.setAppState, 'agent')).toBe(false)
    expect(harness.state.tasks[handle.taskId]?.status).toBe('failed')
    expect(harness.state.tasks[handle.taskId]?.error).toBe('Agent termination failed.')
  })

  test('does not retain a failed user source for a later output-limit termination', async () => {
    const harness = createHarness()
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand('bsource-reuse', 137, 'running', result)
    command.terminateAndWait = async () => false
    command.processExited = false
    command.terminationRequested = false

    const handle = await spawnShellTask({
      command: 'sleep 10',
      description: 'Source reuse',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await killTask(handle.taskId, harness.setAppState, 'user')).toBe(false)
    expect(harness.state.tasks[handle.taskId]?.terminationSource).toBeUndefined()

    command.processExited = true
    command.status = 'killed'
    command.terminationReason = 'output_limit'
    command.terminationRequested = true
    resolveResult({
      stdout: '',
      stderr: '',
      code: 137,
      interrupted: true,
      terminationReason: 'output_limit',
    })

    expect(await waitForTaskStatus(harness, handle.taskId)).toBe('killed')
    expect(harness.state.tasks[handle.taskId]?.terminalReason).toBe('output_limit_termination_confirmed')
    expect(harness.state.tasks[handle.taskId]?.error).toBe('User termination failed.')
  })

  for (const [reason, expected] of [
    ['timeout', 'timeout_termination_confirmed'],
    ['abort', 'abort_termination_confirmed'],
    ['output_limit', 'output_limit_termination_confirmed'],
  ] as const) {
    test(`records a confirmed automatic ${reason} termination distinctly`, async () => {
      const harness = createHarness()
      const taskId = `bautomatic-${reason}-${crypto.randomUUID()}`
      const command = createCommand(taskId, 137, 'killed', Promise.resolve({
        stdout: '', stderr: '', code: 137, interrupted: true, terminationReason: reason,
      }))
      command.terminationReason = reason
      command.terminationRequested = true

      const handle = await spawnShellTask({
        command: 'sleep 10',
        description: 'Automatic termination',
        shellCommand: command,
      }, {
        abortController: new AbortController(),
        getAppState: () => harness.state,
        setAppState: harness.setAppState,
      })

      expect(await waitForTaskStatus(harness, handle.taskId)).toBe('killed')
      expect(harness.state.tasks[handle.taskId]?.terminalReason).toBe(expected)
      expect(harness.state.tasks[handle.taskId]?.error).toBe('')
      await flushLocalShellMetadataWritesForTesting()
      expect((await readLocalShellMetadata(handle.taskId, 'local-shell-task-test', projectDir))?.terminalReason).toBe(expected)
    })
  }

  test('does not label an automatic kill as user termination', async () => {
    const harness = createHarness()
    const command = createCommand('bautomatic-kill', 137, 'killed')
    command.terminationRequested = false

    const handle = await spawnShellTask({
      command: 'sleep 10',
      description: 'Automatic kill',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await waitForTaskStatus(harness, handle.taskId)).toBe('killed')
    expect(harness.state.tasks[handle.taskId]?.error).toBe('')
  })

  test('keeps a killed command in the killed terminal state', async () => {
    const harness = createHarness()
    const command = createCommand('btask-killed', 137, 'killed')

    const handle = await spawnShellTask({
      command: 'sleep 10',
      description: 'Killed command',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(await waitForTaskStatus(harness, handle.taskId)).toBe('killed')
    expect(harness.state.tasks[handle.taskId]?.result?.code).toBe(137)
  })

  test('does not persist a foreground command that never backgrounds', async () => {
    const harness = createHarness()
    const taskId = `bforeground-only-${crypto.randomUUID()}`
    let resolveResult!: (result: Awaited<ShellCommand['result']>) => void
    const result = new Promise<Awaited<ShellCommand['result']>>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand(taskId, 0, 'running', result)

    registerForeground({
      command: 'echo foreground',
      description: 'Foreground only',
      shellCommand: command,
    }, harness.setAppState)
    resolveResult({ stdout: '', stderr: '', code: 0, interrupted: false })

    expect(await waitForTaskStatus(harness, taskId)).toBe('completed')
    expect(await readLocalShellMetadata(taskId, 'local-shell-task-test', projectDir)).toBeNull()
    expect(dequeueAllMatching(notification =>
      notification.value.includes(taskId),
    )).toHaveLength(0)
  })

  test('persists a foreground command after it is backgrounded', async () => {
    const harness = createHarness()
    let resolveResult!: (result: Awaited<ShellCommand['result']>) => void
    const result = new Promise<Awaited<ShellCommand['result']>>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand('bforeground-all', 0, 'running', result)

    const taskId = registerForeground({
      command: 'echo later',
      description: 'Foreground command',
      shellCommand: command,
      shellType: 'powershell',
    }, harness.setAppState)

    expect(harness.state.tasks[taskId]?.isBackgrounded).toBe(false)
    backgroundAll(() => harness.state, harness.setAppState)
    expect(harness.state.tasks[taskId]?.isBackgrounded).toBe(true)

    resolveResult({ stdout: '', stderr: '', code: 0, interrupted: false })
    expect(await waitForTaskStatus(harness, taskId)).toBe('completed')
    let metadata = await readLocalShellMetadata(taskId, 'local-shell-task-test', projectDir)
    for (let attempt = 0; metadata?.lastKnownStatus !== 'completed' && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5))
      metadata = await readLocalShellMetadata(taskId, 'local-shell-task-test', projectDir)
    }
    expect(metadata?.lastKnownStatus).toBe('completed')
    const notifications = dequeueAllMatching(notification =>
      notification.value.includes(taskId),
    )
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.value).toContain('<status>completed</status>')
  })

  test('does not notify when foreground result delivery races with background completion', async () => {
    const harness = createHarness()
    const taskId = 'bforeground-completion-race'
    let resolveResult!: (result: Awaited<ShellCommand['result']>) => void
    const result = new Promise<Awaited<ShellCommand['result']>>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand(taskId, 0, 'running', result)

    registerForeground({
      command: 'echo race',
      description: 'Foreground completion race',
      shellCommand: command,
    }, harness.setAppState)
    const foregroundResult = Promise.race([result]).then(value => {
      markTaskNotified(taskId, harness.setAppState)
      return value
    })
    expect(backgroundExistingForegroundTask(
      taskId,
      command,
      'Foreground completion race',
      harness.setAppState,
    )).toBe(true)

    resolveResult({
      stdout: 'done',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: taskId,
    })
    await foregroundResult
    expect(await waitForTaskStatus(harness, taskId)).toBe('completed')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(dequeueAllMatching(notification =>
      notification.value.includes(taskId),
    )).toHaveLength(0)
  })

  test('keeps process liveness checks active for monitors', async () => {
    const harness = createHarness()
    const taskId = 'bmonitor-disappeared'
    let resolveResult!: (result: ExecResult) => void
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    let intervalCallback: (() => void) | undefined
    let probeCalls = 0
    const interval = { unref() {} } as NodeJS.Timeout
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(callback => {
      intervalCallback = callback as () => void
      return interval
    })
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    try {
      const command = createCommand(taskId, 1, 'running', result)
      Object.defineProperty(command, 'processExited', { get: () => false })
      command.confirmProcessDisappeared = () => {
        probeCalls++
        resolveResult({
          stdout: '',
          stderr: '',
          code: undefined,
          outcomeKnown: false,
          processObservation: 'dead',
          interrupted: false,
        })
        return true
      }

      await spawnShellTask({
        command: 'monitor command',
        description: 'Monitor command',
        shellCommand: command,
        kind: 'monitor',
      }, {
        abortController: new AbortController(),
        getAppState: () => harness.state,
        setAppState: harness.setAppState,
      })

      expect(intervalCallback).toBeDefined()
      intervalCallback?.()
      expect(await waitForTaskStatus(harness, taskId)).toBe('failed')
      expect(probeCalls).toBe(1)
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  test('finalizes a disappeared process without inventing an exit code', async () => {
    const harness = createHarness()
    const taskId = 'bdisappeared'
    let processExited = false
    let resolveResult!: (result: Awaited<ShellCommand['result']>) => void
    const result = new Promise<Awaited<ShellCommand['result']>>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand(taskId, 1, 'running', result)
    Object.defineProperty(command, 'processExited', { get: () => processExited })
    command.confirmProcessDisappeared = () => {
      processExited = true
      resolveResult({
        stdout: '',
        stderr: '',
        code: undefined,
        outcomeKnown: false,
        processObservation: 'dead',
        interrupted: false,
      })
      return true
    }

    const handle = await spawnShellTask({
      command: 'missing',
      description: 'Disappeared command',
      shellCommand: command,
    }, {
      abortController: new AbortController(),
      getAppState: () => harness.state,
      setAppState: harness.setAppState,
    })

    expect(reconcileRunningLocalShellTask(
      handle.taskId,
      command,
      'Disappeared command',
      harness.setAppState,
    )).toBe(true)
    expect(await waitForTaskStatus(harness, handle.taskId)).toBe('failed')
    const task = harness.state.tasks[handle.taskId] as {
      outcomeKnown?: boolean
      processObservation?: string
      terminalReason?: string
      result?: unknown
      shellCommand?: unknown
    }
    expect(task.outcomeKnown).toBe(false)
    expect(task.processObservation).toBe('dead')
    expect(task.terminalReason).toBe('process_disappeared')
    expect(task.result).toBeUndefined()
    expect(task.shellCommand).toBeNull()

    await flushLocalShellMetadataWritesForTesting()
    const metadata = await readLocalShellMetadata(handle.taskId, 'local-shell-task-test', projectDir)
    expect(metadata?.lastKnownStatus).toBe('failed')
    expect(metadata?.outcomeKnown).toBe(false)
    expect(metadata?.terminalReason).toBe('process_disappeared')
    expect(metadata && 'exitCode' in metadata).toBe(false)
    const notifications = dequeueAllMatching(command =>
      command.value.includes(handle.taskId),
    )
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.value).toContain('ended; exit status unavailable')
  })

  test('auto-backgrounds an existing foreground command in place', async () => {
    const harness = createHarness()
    let resolveResult!: (result: Awaited<ShellCommand['result']>) => void
    const result = new Promise<Awaited<ShellCommand['result']>>(resolve => {
      resolveResult = resolve
    })
    const command = createCommand('bforeground-existing', 3, 'running', result)

    const taskId = registerForeground({
      command: 'exit 3',
      description: 'Existing foreground command',
      shellCommand: command,
    }, harness.setAppState)

    expect(backgroundExistingForegroundTask(
      taskId,
      command,
      'Existing foreground command',
      harness.setAppState,
    )).toBe(true)
    expect(harness.state.tasks[taskId]?.isBackgrounded).toBe(true)

    resolveResult({ stdout: '', stderr: '', code: 3, interrupted: false })
    expect(await waitForTaskStatus(harness, taskId)).toBe('failed')
  })
})
