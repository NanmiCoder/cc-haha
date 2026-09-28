import { describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { IDLE_SPECULATION_STATE, type AppState } from '../../state/AppState.js'
import type { SessionId } from '../../types/ids.js'
import * as shell from '../../utils/Shell.js'
import * as detection from '../../utils/shell/powershellDetection.js'
import { wrapSpawn } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { killTask } from '../../tasks/LocalShellTask/killShellTasks.js'
import { getLocalShellFinalization } from '../../tasks/LocalShellTask/guards.js'
import { resetStateForTests, setIsInteractive, switchSession } from '../../bootstrap/state.js'
import { flushLocalShellMetadataWritesForTesting, readLocalShellMetadata, resetProjectForTesting } from '../../utils/sessionStorage.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { PowerShellTool } from './PowerShellTool.js'

for (const outcome of ['natural', 'stop'] as const) {
  test(`PowerShell 超时终止失败后保留任务并支持 ${outcome}`, async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'powershell-timeout-chain-'))
    resetStateForTests()
    setIsInteractive(false)
    switchSession('powershell-timeout-chain' as SessionId, projectDir)
    let state = { tasks: {}, speculation: IDLE_SPECULATION_STATE } as AppState
    const setAppState = (update: (previous: AppState) => AppState) => { state = update(state) }
    const child = Object.assign(new EventEmitter(), {
      pid: 4321, stdout: null, stderr: null, kill: () => false,
    })
    let allowStop = false
    const command = wrapSpawn(child as never, new AbortController().signal, 60_000,
      new TaskOutput(`bpowershell-timeout-${outcome}`, null, false), false, undefined, {
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
    const detectionSpy = spyOn(detection, 'getCachedPowerShellPath').mockResolvedValue('pwsh')
    const context = {
      abortController: new AbortController(), getAppState: () => state,
      setAppState, toolUseId: 'powershell-timeout-chain',
    } as ToolUseContext
    try {
      const failure = PowerShellTool.call({ command: 'Write-Output test', timeout_behavior: 'terminate' }, context).catch(error => error)
      expect(await command.terminateAndWait(1, 'timeout')).toBe(false)
      expect(await failure).toMatchObject({ message: 'Command timed out; termination failed. Process exit is not confirmed.' })
      expect(execSpy).toHaveBeenCalledWith('Write-Output test', context.abortController.signal, 'powershell', expect.objectContaining({ timeoutBehavior: 'terminate' }))
      const taskId = command.taskOutput.taskId
      expect(state.tasks[taskId]).toMatchObject({
        status: 'running', isBackgrounded: true, shellCommand: command,
        error: 'Command timed out; termination failed. Process exit is not confirmed.',
      })
      await flushLocalShellMetadataWritesForTesting()
      await expect(readLocalShellMetadata(taskId, 'powershell-timeout-chain', projectDir)).resolves.toMatchObject({
        lastKnownStatus: 'running', shellType: 'powershell',
        error: 'Command timed out; termination failed. Process exit is not confirmed.',
      })
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
      detectionSpy.mockRestore()
      await new Promise(resolve => setTimeout(resolve, 0))
      await flushLocalShellMetadataWritesForTesting()
      dequeueAllMatching(message => message.mode === 'task-notification')
      resetProjectForTesting()
      resetStateForTests()
      await rm(projectDir, { recursive: true, force: true })
    }
  }, 20_000)
}

describe('PowerShell timeout_behavior schema', () => {
  test('accepts background and terminate behaviors', () => {
    const schema = PowerShellTool.inputSchema

    expect(schema.parse({ command: 'Write-Output test', timeout_behavior: 'background' }).timeout_behavior).toBe('background')
    expect(schema.parse({ command: 'Write-Output test', timeout_behavior: 'terminate' }).timeout_behavior).toBe('terminate')
  })

  test('rejects unsupported timeout behavior', () => {
    expect(() => PowerShellTool.inputSchema.parse({ command: 'Write-Output test', timeout_behavior: 'restart' })).toThrow()
  })

  test('exposes timeout behavior in results', () => {
    const result = PowerShellTool.outputSchema.parse({
      stdout: 'output',
      stderr: '',
      interrupted: false,
      timeoutBehavior: 'terminate',
    })

    expect(result.timeoutBehavior).toBe('terminate')
  })
})
