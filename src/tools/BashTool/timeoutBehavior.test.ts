import { describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { IDLE_SPECULATION_STATE, type AppState } from '../../state/AppState.js'
import type { SessionId } from '../../types/ids.js'
import * as shell from '../../utils/Shell.js'
import { wrapSpawn } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { killTask } from '../../tasks/LocalShellTask/killShellTasks.js'
import { getLocalShellFinalization } from '../../tasks/LocalShellTask/guards.js'
import { resetStateForTests, setIsInteractive, switchSession } from '../../bootstrap/state.js'
import { flushLocalShellMetadataWritesForTesting, readLocalShellMetadata, resetProjectForTesting } from '../../utils/sessionStorage.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { BashTool } from './BashTool.js'

describe('Bash timeout termination lifecycle', () => {
  for (const outcome of ['natural', 'stop'] as const) {
    test(`工具报告超时终止失败后保留后台任务并支持 ${outcome}`, async () => {
      const projectDir = await mkdtemp(join(tmpdir(), 'bash-timeout-chain-'))
      resetStateForTests()
      setIsInteractive(false)
      switchSession('bash-timeout-chain' as SessionId, projectDir)
      let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
      const setAppState = (update: (previous: AppState) => AppState) => { state = update(state) }
      const child = Object.assign(new EventEmitter(), {
        pid: 4321,
        stdout: null,
        stderr: null,
        kill: () => false,
      })
      let allowStop = false
      const command = wrapSpawn(child as never, new AbortController().signal, 60_000,
        new TaskOutput(`btimeout-chain-${outcome}`, null, false), false, undefined, {
          probe: () => 'alive',
          killGroup: () => false,
          killTree: (_pid, callback) => {
            if (allowStop) {
              callback()
              queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
            } else {
              callback(new Error('access denied'))
            }
          },
        })
      const execSpy = spyOn(shell, 'exec').mockResolvedValue(command)
      const context = {
        abortController: new AbortController(),
        getAppState: () => state,
        setAppState,
        toolUseId: 'timeout-chain',
      } as ToolUseContext
      try {
        const call = BashTool.call({ command: 'echo test', timeout_behavior: 'terminate' }, context)
        const failure = call.catch(error => error)
        expect(await command.terminateAndWait(1, 'timeout')).toBe(false)
        expect(await failure).toMatchObject({ message: 'Command timed out; termination failed. Process exit is not confirmed.' })
        const taskId = command.taskOutput.taskId
        expect(state.tasks[taskId]).toMatchObject({
          status: 'running',
          isBackgrounded: true,
          error: 'Command timed out; termination failed. Process exit is not confirmed.',
        })
        await flushLocalShellMetadataWritesForTesting()
        await expect(readLocalShellMetadata(taskId, 'bash-timeout-chain', projectDir)).resolves.toMatchObject({
          lastKnownStatus: 'running',
          error: 'Command timed out; termination failed. Process exit is not confirmed.',
        })
        expect(state.tasks[taskId]?.shellCommand).toBe(command)
        expect(command.processExited).toBe(false)
        const finalization = getLocalShellFinalization(taskId)
        if (outcome === 'stop') {
          allowStop = true
          expect(await killTask(taskId, setAppState)).toBe(true)
          expect(state.tasks[taskId]?.status).toBe('killed')
        } else {
          child.emit('exit', 0, null)
          await command.completion
          await finalization
          expect(state.tasks[taskId]?.status).toBe('completed')
        }
        expect(state.tasks[taskId]?.shellCommand).toBeNull()
      } finally {
        if (!command.processExited) child.emit('exit', 0, null)
        await command.completion
        command.cleanup()
        execSpy.mockRestore()
        await flushLocalShellMetadataWritesForTesting()
        dequeueAllMatching(message => message.mode === 'task-notification')
        resetProjectForTesting()
        resetStateForTests()
        await rm(projectDir, { recursive: true, force: true })
      }
    }, 10_000)
  }
})

describe('Bash timeout_behavior schema', () => {
  test('accepts background and terminate behaviors', () => {
    const schema = BashTool.inputSchema

    expect(schema.parse({ command: 'echo test', timeout_behavior: 'background' }).timeout_behavior).toBe('background')
    expect(schema.parse({ command: 'echo test', timeout_behavior: 'terminate' }).timeout_behavior).toBe('terminate')
  })

  test('rejects unsupported timeout behavior', () => {
    expect(() => BashTool.inputSchema.parse({ command: 'echo test', timeout_behavior: 'restart' })).toThrow()
  })

  test('exposes timeout behavior in results', () => {
    const result = BashTool.outputSchema.parse({
      stdout: 'output',
      stderr: '',
      interrupted: false,
      timeoutBehavior: 'terminate',
    })

    expect(result.timeoutBehavior).toBe('terminate')
  })
})
