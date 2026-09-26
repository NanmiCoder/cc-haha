import { afterEach, describe, expect, test } from 'bun:test'
import { exec } from '../utils/Shell.js'
import type { ShellCommand } from '../utils/ShellCommand.js'

const running: ShellCommand[] = []
const testShell = process.platform === 'win32' ? 'powershell' : 'bash'
const sleepCommand = process.platform === 'win32'
  ? 'Start-Sleep -Seconds 5'
  : 'sleep 5'

afterEach(() => {
  for (const command of running.splice(0)) {
    command.kill()
    command.cleanup()
  }
})

describe('Shell.exec timeout_behavior wiring', () => {
  test('terminate requests termination instead of exposing a background callback', async () => {
    const command = await exec(sleepCommand, new AbortController().signal, testShell, {
      timeout: 100,
      shouldAutoBackground: false,
      timeoutBehavior: 'terminate',
    })
    running.push(command)

    expect(command.onTimeout).toBeUndefined()
    await command.result

    expect(command.terminationRequested).toBe(true)
    expect(command.terminationReason).toBe('timeout')
    expect(command.processExited).toBe(true)
  }, 30_000)

  test('background exposes the timeout callback instead of terminating', async () => {
    const command = await exec(sleepCommand, new AbortController().signal, testShell, {
      timeout: 100,
      shouldAutoBackground: true,
      timeoutBehavior: 'background',
    })
    running.push(command)

    expect(command.onTimeout).toBeDefined()
    let backgroundFn: ((taskId: string) => boolean) | undefined
    command.onTimeout?.(fn => {
      backgroundFn = fn
    })

    // The timeout fires while the child is still running; backgrounding it
    // before it exits keeps the process alive under a background task id.
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(command.terminationRequested).toBe(false)
    expect(backgroundFn?.(`b${Date.now()}`)).toBe(true)
    expect(command.status).toBe('backgrounded')

    command.kill()
    await command.result
  }, 30_000)
})
