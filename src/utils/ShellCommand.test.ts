import { EventEmitter } from 'events'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'fs/promises'
import { TaskOutput } from './task/TaskOutput.js'
import {
  createAbortedCommand,
  createFailedCommand,
  wrapSpawn,
  killDetachedProcessGroup,
  type ShellProcessControl,
} from './ShellCommand.js'

type TestChild = EventEmitter & {
  pid?: number
  stdout: null
  stderr: null
  kill: (signal?: NodeJS.Signals | number) => boolean
}

function createChild(): TestChild {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout: null,
    stderr: null,
    kill: () => false,
  })
}

function processControl(probe: ShellProcessControl['probe'] = () => 'alive'): ShellProcessControl {
  return {
    probe,
    killGroup: () => false,
    killTree: () => {},
  }
}

function wrapTestSpawn(
  child: TestChild,
  taskId: string,
  options: {
    timeout?: number
    autoBackground?: boolean
    abortSignal?: AbortSignal
    maxOutputBytes?: number
    probe?: ShellProcessControl['probe']
    processControl?: ShellProcessControl
    stdoutToFile?: boolean
  } = {},
) {
  return wrapSpawn(
    child as never,
    options.abortSignal ?? new AbortController().signal,
    options.timeout ?? 60_000,
    new TaskOutput(taskId, null, options.stdoutToFile ?? false),
    options.autoBackground ?? false,
    options.maxOutputBytes,
    options.processControl ?? processControl(options.probe),
  )
}

describe('ShellCommand termination', () => {
  test('does not resolve or report killed before the child exits', async () => {
    const child = createChild()
    child.pid = 1234
    const command = wrapTestSpawn(child, 'btermination-test', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => callback(),
      },
    })

    let resolved = false
    void command.result.then(() => {
      resolved = true
    })
    command.kill()

    await Promise.resolve()
    expect(command.pid).toBe(1234)
    expect(command.terminationRequested).toBe(true)
    expect(command.terminationReason).toBe('user')
    expect(command.terminationFailure).toBe(false)
    expect(command.terminationConfirmed).toBe(false)
    expect(command.status).toBe('running')
    expect(resolved).toBe(false)

    expect(command.processExited).toBe(false)
    expect(await command.waitForExit(1)).toBe(false)
    expect(command.status).toBe('running')

    child.emit('exit', null, 'SIGKILL')
    expect(command.terminationConfirmed).toBe(true)
    const result = await command.result
    expect(command.processExited).toBe(true)
    expect(await command.waitForExit(1)).toBe(true)
    expect(command.status).toBe('killed')
    expect(result.code).toBe(137)
    command.cleanup()
  })

  test('marks an OS-confirmed disappearance as killed after dispatch succeeds', async () => {
    const child = createChild()
    child.pid = 1234
    const command = wrapTestSpawn(child, 'bdisappeared-after-dispatch', {
      processControl: {
        probe: () => 'dead',
        killGroup: () => true,
        killTree: () => {},
      },
    })

    command.kill()

    expect(await command.waitForExit(1)).toBe(true)
    expect(command.status).toBe('killed')
    expect(command.terminationConfirmed).toBe(true)
    command.cleanup()
  })

  test('keeps an OS-confirmed disappearance completed when dispatch fails', async () => {
    const child = createChild()
    child.pid = 1235
    const command = wrapTestSpawn(child, 'bdisappeared-after-dispatch-failure', {
      processControl: {
        probe: () => 'dead',
        killGroup: () => false,
        killTree: (_pid, callback) => callback(new Error('access denied')),
      },
    })

    command.kill()

    expect(await command.waitForExit(1)).toBe(true)
    expect(command.status).toBe('completed')
    expect(command.terminationConfirmed).toBe(false)
    command.cleanup()
  })

  test('does not reuse a failed termination dispatch when the process later disappears', async () => {
    const child = createChild()
    child.pid = 1235
    let processState: 'alive' | 'dead' = 'alive'
    let probeCallback: (() => void) | undefined
    const interval = { unref() {} } as NodeJS.Timeout
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      ((callback: () => void) => {
        probeCallback = callback
        return interval
      }) as typeof setInterval,
    )
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    let treeCallback: ((error?: Error | null) => void) | undefined
    const command = wrapTestSpawn(child, 'blate-termination-dispatch', {
      processControl: {
        probe: () => processState,
        killGroup: () => false,
        killTree: (_pid, callback) => { treeCallback = callback },
      },
    })

    try {
      expect(await command.terminateAndWait(1, 'timeout')).toBe(false)
      expect(probeCallback).toBeDefined()
      processState = 'dead'
      treeCallback?.()
      probeCallback?.()
      await expect(command.completion).resolves.toMatchObject({
        outcomeKnown: false,
        processObservation: 'dead',
      })
      expect(command.status).toBe('completed')
      expect(command.terminationConfirmed).toBe(false)
    } finally {
      command.cleanup()
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  test('starts an error probe when dispatch confirmation times out', () => {
    const child = createChild()
    child.pid = 1234
    let processState: 'alive' | 'dead' = 'alive'
    let dispatchTimer: (() => void) | undefined
    let probeCallback: (() => void) | undefined
    const timer = { unref() {} } as NodeJS.Timeout
    const interval = { unref() {} } as NodeJS.Timeout
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((callback: TimerHandler, delay?: number) => {
        if (delay === 5_000) dispatchTimer = callback as () => void
        return timer
      }) as typeof setTimeout,
    )
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      ((callback: () => void) => {
        probeCallback = callback
        return interval
      }) as typeof setInterval,
    )
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const command = wrapTestSpawn(child, 'bdispatch-timeout-probe', {
      processControl: {
        probe: () => processState,
        killGroup: () => false,
        killTree: () => {},
      },
    })

    try {
      command.kill()
      expect(dispatchTimer).toBeDefined()
      dispatchTimer?.()
      expect(probeCallback).toBeDefined()
      processState = 'dead'
      probeCallback?.()
      expect(command.processExited).toBe(true)
    } finally {
      command.cleanup()
      setTimeoutSpy.mockRestore()
      setIntervalSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  test('keeps a successful group dispatch when redundant tree termination fails', async () => {
    const child = createChild()
    child.pid = 1234
    child.kill = () => false
    const command = wrapTestSpawn(child, 'bgroup-dispatch-wins', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => true,
        killTree: (_pid, callback) => callback(new Error('tree lookup failed')),
      },
    })

    command.kill()
    child.emit('exit', null, 'SIGKILL')

    await expect(command.result).resolves.toMatchObject({ terminationFailure: false })
    expect(command.status).toBe('killed')
    expect(command.terminationConfirmed).toBe(true)
    command.cleanup()
  })

  test('converges a direct abort when kill dispatch fails and the process disappears', async () => {
    const child = createChild()
    child.pid = 1235
    let processState: 'alive' | 'dead' = 'alive'
    const controller = new AbortController()
    const abortedCommand = wrapTestSpawn(child, 'babort-disappeared-live', {
      abortSignal: controller.signal,
      processControl: {
        probe: () => processState,
        killGroup: () => false,
        killTree: (_pid, callback) => callback(new Error('access denied')),
      },
    })

    controller.abort('cancelled')
    expect(abortedCommand.terminationReason).toBe('abort')
    processState = 'dead'
    expect(abortedCommand.confirmProcessDisappeared()).toBe(true)
    await expect(abortedCommand.result).resolves.toMatchObject({
      outcomeKnown: false,
      processObservation: 'dead',
      terminationReason: 'abort',
    })
    abortedCommand.cleanup()
  })

  test('treats a natural exit after a failed termination request as completed', async () => {
    const child = createChild()
    child.pid = 1235
    const command = wrapTestSpawn(child, 'bnatural-exit-test')

    command.kill()
    expect(command.terminationReason).toBe('user')
    child.emit('exit', 0, null)

    await command.result
    expect(command.status).toBe('completed')
    command.cleanup()
  })

  test('treats a numeric exit as killed after the termination command succeeds', async () => {
    const child = createChild()
    child.pid = 1236
    const command = wrapTestSpawn(child, 'bwindows-kill-test', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => callback(),
      },
    })

    command.kill()
    child.emit('exit', 1, null)

    await command.result
    expect(command.status).toBe('completed')
    command.cleanup()
  })

  test('falls back to killing the child when tree termination fails', async () => {
    const child = createChild()
    child.pid = 1237
    let observedSignal: NodeJS.Signals | number | undefined
    child.kill = signal => {
      observedSignal = signal
      queueMicrotask(() => child.emit('exit', null, signal))
      return true
    }
    const command = wrapTestSpawn(child, 'btree-kill-fallback-test', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => callback(new Error('access denied')),
      },
    })

    command.kill()

    await command.result
    expect(observedSignal).toBeDefined()
    expect(command.status).toBe('killed')
    command.cleanup()
  })

  test('ignores a late process error after cleanup', () => {
    const child = createChild()
    child.pid = 1238
    const command = wrapTestSpawn(child, 'blate-error-after-cleanup')

    command.cleanup()

    expect(() => child.emit('error', new Error('late error'))).not.toThrow()
  })

  test('resolves a spawn error after termination was requested', async () => {
    const child = createChild()
    child.pid = undefined
    const command = wrapTestSpawn(child, 'bspawn-error-test')

    command.kill()
    expect(command.terminationReason).toBe('user')
    child.emit('error', new Error('spawn failed'))

    await expect(command.result).resolves.toMatchObject({ code: 1, terminationReason: 'user' })
    expect(await command.waitForExit(1)).toBe(true)
    command.cleanup()
  })

  test('settles an error on a dead pid after probing confirms the process is gone', async () => {
    const child = createChild()
    child.pid = 1238
    const command = wrapTestSpawn(child, 'berror-noexit-test', { probe: () => 'dead' })

    child.emit('error', new Error('epipe'))
    // The pid does not exist, so the immediate probe reports dead and settles.
    expect(command.processExited).toBe(true)
    expect(await command.waitForExit(1)).toBe(true)
    await expect(command.result).resolves.toMatchObject({
      outcomeKnown: false,
      processObservation: 'dead',
    })
    expect(command.processExited).toBe(true)
    expect(await command.waitForExit(1)).toBe(true)
    command.cleanup()
  }, 10_000)

  test('never marks an error on a still-alive pid as exited', async () => {
    const child = createChild()
    child.pid = process.pid
    const command = wrapTestSpawn(child, 'berror-alive-test')

    child.emit('error', new Error('epipe'))
    // The pid refers to a live process (our own); the probe must NOT settle.
    expect(command.processExited).toBe(false)
    expect(await command.waitForExit(1)).toBe(false)
    let settled = false
    void command.result.then(() => { settled = true }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(settled).toBe(false)
    expect(command.processExited).toBe(false)
    // A real exit event resolves it.
    child.emit('exit', 0, null)
    await expect(command.result).resolves.toMatchObject({ code: 0 })
    expect(command.processExited).toBe(true)
    command.cleanup()
  }, 10_000)

  test('converges kill+error+no-exit when the pid is confirmed dead', async () => {
    const child = createChild()
    child.pid = 0
    const command = wrapTestSpawn(child, 'berror-term-test', { probe: () => 'dead' })

    command.kill()
    child.emit('error', new Error('kill race'))
    expect(command.processExited).toBe(true)
    expect(await command.waitForExit(1)).toBe(true)
    await expect(command.result).resolves.toMatchObject({
      outcomeKnown: false,
      processObservation: 'dead',
      terminationReason: 'user',
    })
    expect(command.processExited).toBe(true)
    expect(command.status).toBe('completed')
    expect(await command.waitForExit(1)).toBe(true)
    command.cleanup()
  }, 10_000)

  test('keeps probing after background so error+no-exit still converges', async () => {
    const child = createChild()
    child.pid = process.pid
    const command = wrapTestSpawn(child, 'berror-bg-test')

    expect(command.background('bbg-converge')).toBe(true)
    child.emit('error', new Error('epipe'))
    expect(command.processExited).toBe(false)
    child.emit('exit', 0, null)
    await expect(command.result).resolves.toMatchObject({ code: 0 })
    expect(command.processExited).toBe(true)
    command.cleanup()
  }, 10_000)

  test('confirms a disappeared process during wait timeout', async () => {
    const child = createChild()
    child.pid = 1239
    const command = wrapTestSpawn(child, 'btimeout-disappeared-test', { probe: () => 'dead' })

    expect(await command.waitForExit(1)).toBe(true)
    await expect(command.result).resolves.toMatchObject({
      outcomeKnown: false,
      processObservation: 'dead',
    })
    expect(command.processExited).toBe(true)
    command.cleanup()
  })

  test('does not label a user stop as a timeout', async () => {
    const child = createChild()
    child.pid = 1240
    const command = wrapTestSpawn(child, 'buser-stop-test')

    command.kill()
    child.emit('exit', null, 'SIGTERM')

    await expect(command.result).resolves.toMatchObject({
      code: 143,
      terminationReason: 'user',
    })
    expect((await command.result).stderr).not.toContain('Command timed out')
    command.cleanup()
  })

  test('uses the reason from the current termination generation', async () => {
    const child = createChild()
    child.pid = 1243
    let killAttempts = 0
    const command = wrapTestSpawn(child, 'btermination-reason-race', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => {
          killAttempts++
          if (killAttempts === 1) {
            callback(new Error('access denied'))
            return
          }
          callback()
          queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
        },
      },
    })

    expect(await command.terminateAndWait(1, 'timeout')).toBe(false)
    expect(command.terminationReason).toBe('timeout')

    expect(killAttempts).toBe(1)
    expect(await command.terminateAndWait(20, 'user')).toBe(true)
    expect(killAttempts).toBe(2)
    expect(command.terminationReason).toBe('user')

    const result = await command.result
    expect(result.terminationReason).toBe('user')
    expect(result.stderr).not.toContain('Command timed out')
    command.cleanup()
  })

  test('does not let an expired timeout waiter deactivate a newer termination attempt', async () => {
    const child = createChild()
    child.pid = 1246
    const callbacks: Array<(error?: Error | null) => void> = []
    const command = wrapTestSpawn(child, 'bgeneration-race-test', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => { callbacks.push(callback) },
      },
    })

    const timeoutTermination = command.terminateAndWait(5, 'timeout')
    const userTermination = command.terminateAndWait(100, 'user')
    expect(callbacks).toHaveLength(2)
    callbacks[1]!()
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))

    expect(await userTermination).toBe(true)
    expect(await timeoutTermination).toBe(false)
    expect(command.terminationReason).toBe('user')
    await expect(command.result).resolves.toMatchObject({ terminationReason: 'user' })
    command.cleanup()
  })

  test('does not let an abort attempt be cleared by an expired timeout waiter', async () => {
    const child = createChild()
    child.pid = 1250
    const controller = new AbortController()
    const callbacks: Array<(error?: Error | null) => void> = []
    const command = wrapTestSpawn(child, 'babort-generation-race', {
      abortSignal: controller.signal,
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => { callbacks.push(callback) },
      },
    })

    const timeoutTermination = command.terminateAndWait(5, 'timeout')
    controller.abort('cancelled')
    expect(callbacks).toHaveLength(2)
    callbacks[1]!()
    child.emit('exit', null, 'SIGTERM')

    expect(await timeoutTermination).toBe(false)
    await expect(command.result).resolves.toMatchObject({ terminationReason: 'abort' })
    expect(command.status).toBe('killed')
    command.cleanup()
  })

  test('does not publish an old timeout failure after a newer user attempt', async () => {
    const child = createChild()
    child.pid = 1247
    const callbacks: Array<(error?: Error | null) => void> = []
    const command = wrapTestSpawn(child, 'bgeneration-failure-test', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => { callbacks.push(callback) },
      },
    })

    const timeoutTermination = command.terminateAndWait(5, 'timeout')
    const userTermination = command.terminateAndWait(100, 'user')
    callbacks[1]!()
    child.emit('exit', null, 'SIGTERM')

    expect(await userTermination).toBe(true)
    expect(await timeoutTermination).toBe(false)
    const winner = await Promise.race([
      command.terminationFailureResult.then(() => 'failure'),
      new Promise(resolve => setTimeout(() => resolve('result'), 20)),
    ])
    expect(winner).toBe('result')
    command.cleanup()
  })

  test('waits for a POSIX signal exit dispatch before settling', async () => {
    const child = createChild()
    child.pid = 1247
    let treeCallback: ((error?: Error | null) => void) | undefined
    const command = wrapTestSpawn(child, 'bposix-dispatch-order', {
      processControl: {
        platform: 'linux',
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => { treeCallback = callback },
      },
    })

    const termination = command.terminateAndWait(100, 'user')
    child.emit('exit', null, 'SIGTERM')
    await Promise.resolve()
    expect(command.status).toBe('running')
    treeCallback?.()

    await expect(termination).resolves.toBe(true)
    await expect(command.result).resolves.toMatchObject({
      code: 143,
      terminationReason: 'user',
    })
    expect(command.status).toBe('killed')
    command.cleanup()
  })

  test('settles a POSIX signal exit as completed when dispatch fails', async () => {
    const child = createChild()
    child.pid = 1248
    let treeCallback: ((error?: Error | null) => void) | undefined
    const command = wrapTestSpawn(child, 'bposix-dispatch-failure', {
      processControl: {
        platform: 'linux',
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => { treeCallback = callback },
      },
    })

    const termination = command.terminateAndWait(100, 'user')
    child.emit('exit', null, 'SIGTERM')
    treeCallback?.(new Error('taskkill failed'))

    await expect(termination).resolves.toBe(false)
    await expect(command.result).resolves.toMatchObject({
      code: 143,
      terminationReason: 'user',
    })
    expect(command.status).toBe('completed')
    expect(command.terminationConfirmed).toBe(false)
    command.cleanup()
  })

  test('waits for bounded process confirmation on output-limit termination', async () => {
    const child = createChild()
    child.pid = 1251
    const command = wrapTestSpawn(child, 'boutput-limit-no-exit', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => callback(),
      },
    })

    const termination = await command.terminateAndWait(1, 'output_limit')
    expect(termination).toBe(false)
    expect(command.terminationFailure).toBe(true)
    expect(command.status).toBe('running')
    child.emit('exit', null, 'SIGKILL')
    await expect(command.result).resolves.toMatchObject({
      terminationFailure: true,
      terminationReason: 'output_limit',
    })
    command.cleanup()
  })

  test('does not settle disappearance before pending dispatch provenance', async () => {
    const child = createChild()
    child.pid = 1252
    let treeCallback: ((error?: Error | null) => void) | undefined
    const command = wrapTestSpawn(child, 'bdisappearance-dispatch-order', {
      processControl: {
        probe: () => 'dead',
        killGroup: () => false,
        killTree: (_pid, callback) => { treeCallback = callback },
      },
    })

    command.kill()
    expect(command.confirmProcessDisappeared()).toBe(true)
    expect(command.status).toBe('running')
    treeCallback?.()
    await expect(command.result).resolves.toMatchObject({
      terminationReason: 'user',
      outcomeKnown: false,
    })
    expect(command.status).toBe('killed')
    command.cleanup()
  })

  test('prefers a real exit after an earlier disappearance observation', async () => {
    const child = createChild()
    child.pid = 1253
    let treeCallback: ((error?: Error | null) => void) | undefined
    const command = wrapTestSpawn(child, 'bdisappearance-real-exit', {
      processControl: {
        platform: 'linux',
        probe: () => 'dead',
        killGroup: () => false,
        killTree: (_pid, callback) => { treeCallback = callback },
      },
    })

    const termination = command.terminateAndWait(100, 'user')
    expect(command.confirmProcessDisappeared()).toBe(true)
    child.emit('exit', 0, null)
    treeCallback?.()

    await expect(termination).resolves.toBe(false)
    await expect(command.result).resolves.toMatchObject({
      code: 0,
      terminationReason: 'user',
    })
    expect(command.status).toBe('completed')
    expect(command.terminationConfirmed).toBe(false)
    command.cleanup()
  })

  test('starts an automatic probe for an immediate abort dispatch failure', async () => {
    const child = createChild()
    child.pid = 1249
    let processState: 'alive' | 'dead' = 'alive'
    let probeCallback: (() => void) | undefined
    const interval = { unref() {} } as NodeJS.Timeout
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      ((callback: () => void) => {
        probeCallback = callback
        return interval
      }) as typeof setInterval,
    )
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const controller = new AbortController()
    const command = wrapTestSpawn(child, 'bimmediate-abort-probe', {
      abortSignal: controller.signal,
      processControl: {
        probe: () => processState,
        killGroup: () => false,
        killTree: (_pid, callback) => callback(new Error('access denied')),
      },
    })

    try {
      controller.abort('cancelled')
      expect(probeCallback).toBeDefined()
      processState = 'dead'
      probeCallback?.()
      await expect(command.result).resolves.toMatchObject({
        outcomeKnown: false,
        processObservation: 'dead',
        terminationReason: 'abort',
      })
    } finally {
      command.cleanup()
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  test('classifies a Windows numeric exit as killed after dispatch succeeds', async () => {
    const child = createChild()
    child.pid = 1248
    let treeCallback: ((error?: Error | null) => void) | undefined
    const command = wrapTestSpawn(child, 'bwindows-dispatch-order', {
      processControl: {
        platform: 'win32',
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => { treeCallback = callback },
      },
    })

    command.kill()
    child.emit('exit', 1, null)
    let settled = false
    void command.result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    treeCallback?.()

    await expect(command.result).resolves.toMatchObject({ code: 1 })
    expect(command.status).toBe('killed')
    expect(command.terminationConfirmed).toBe(true)
    command.cleanup()
  })

  test('keeps a Windows natural numeric exit completed when dispatch fails', async () => {
    const child = createChild()
    child.pid = 1249
    let treeCallback: ((error?: Error | null) => void) | undefined
    const command = wrapTestSpawn(child, 'bwindows-natural-order', {
      processControl: {
        platform: 'win32',
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => { treeCallback = callback },
      },
    })

    command.kill()
    child.emit('exit', 1, null)
    treeCallback?.(new Error('taskkill failed'))

    await expect(command.result).resolves.toMatchObject({ code: 1 })
    expect(command.status).toBe('completed')
    expect(command.terminationConfirmed).toBe(false)
    command.cleanup()
  })

  test('records an AbortSignal termination as abort', async () => {
    const child = createChild()
    child.pid = 1241
    const controller = new AbortController()
    const command = wrapTestSpawn(child, 'babort-reason-test', {
      abortSignal: controller.signal,
    })

    controller.abort('cancelled')
    expect(command.terminationReason).toBe('abort')
    child.emit('exit', null, 'SIGTERM')

    await expect(command.result).resolves.toMatchObject({
      code: 143,
      terminationReason: 'abort',
    })
    command.cleanup()
  })

  test('allows the output watchdog after a failed non-output termination', async () => {
    const child = createChild()
    child.pid = 1242
    let watchdog: (() => void) | undefined
    const interval = { unref() {} } as NodeJS.Timeout
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      ((callback: () => void) => {
        watchdog = callback
        return interval
      }) as typeof setInterval,
    )
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const statSpy = spyOn(fs, 'stat').mockResolvedValue({ size: 1 } as Awaited<ReturnType<typeof fs.stat>>)
    const callbacks: Array<(error?: Error | null) => void> = []
    const command = wrapTestSpawn(child, 'boutput-limit-after-failure', {
      maxOutputBytes: 0,
      stdoutToFile: true,
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => { callbacks.push(callback) },
      },
    })

    try {
      expect(await command.terminateAndWait(1, 'user')).toBe(false)
      expect(command.terminationFailure).toBe(true)
      expect(command.background('boutput-limit-after-failure-background')).toBe(true)
      watchdog?.()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(command.terminationReason).toBe('output_limit')
      expect(callbacks).toHaveLength(2)
      watchdog?.()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(callbacks).toHaveLength(2)
    } finally {
      command.cleanup()
      statSpy.mockRestore()
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  test('records output-limit termination separately from user stops', async () => {
    const child = createChild()
    child.pid = 1242
    let watchdog: (() => void) | undefined
    const interval = { unref() {} } as NodeJS.Timeout
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      ((callback: () => void) => {
        watchdog = callback
        return interval
      }) as typeof setInterval,
    )
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const statSpy = spyOn(fs, 'stat').mockResolvedValue({ size: 1 } as Awaited<ReturnType<typeof fs.stat>>)
    const command = wrapTestSpawn(child, 'boutput-limit-reason-test', {
      maxOutputBytes: 0,
      stdoutToFile: true,
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => callback(),
      },
    })

    try {
      expect(command.background('boutput-limit-background')).toBe(true)
      expect(watchdog).toBeDefined()
      watchdog?.()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(command.terminationReason).toBe('output_limit')
      child.emit('exit', null, 'SIGKILL')

      await expect(command.result).resolves.toMatchObject({
        code: 137,
        terminationReason: 'output_limit',
      })
    } finally {
      command.cleanup()
      statSpy.mockRestore()
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  for (const code of [0, 1]) {
    test(`does not report timeout termination failure when the command exits naturally with code ${code}`, async () => {
      const child = createChild()
      child.pid = 1243
      const command = wrapTestSpawn(child, `btimeout-natural-${code}`, {
        processControl: {
          probe: () => 'alive',
          killGroup: () => false,
          killTree: (_pid, callback) => callback(new Error('access denied')),
        },
      })

      const termination = command.terminateAndWait(100, 'timeout')
      child.emit('exit', code, null)

      expect(await termination).toBe(false)
      expect(command.processExited).toBe(true)
      expect(command.terminationFailure).toBe(false)
      expect(await command.result).toMatchObject({ code, terminationFailure: false })
      const winner = await Promise.race([
        command.result.then(() => 'result'),
        command.terminationFailureResult.then(() => 'termination failure'),
      ])
      expect(winner).toBe('result')
      command.cleanup()
    })
  }

  test('does not publish timeout failure when exit is observed just after the wait expires', async () => {
    const child = createChild()
    child.pid = 1245
    const command = wrapTestSpawn(child, 'btimeout-exit-at-deadline', {
      processControl: {
        probe: () => {
          queueMicrotask(() => child.emit('exit', 0, null))
          return 'alive'
        },
        killGroup: () => false,
        killTree: (_pid, callback) => callback(new Error('access denied')),
      },
    })

    expect(await command.terminateAndWait(1, 'timeout')).toBe(false)
    expect(command.processExited).toBe(true)
    expect(command.terminationFailure).toBe(false)
    expect(await command.result).toMatchObject({ code: 0, terminationFailure: false })
    command.cleanup()
  })

  test('publishes bounded timeout failure while retaining a live process for backgrounding', async () => {
    const child = createChild()
    child.pid = 1244
    const command = wrapTestSpawn(child, 'btimeout-failure-result-test', {
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => callback(new Error('access denied')),
      },
    })

    const termination = command.terminateAndWait(1, 'timeout')
    const failure = await command.terminationFailureResult!

    expect(await termination).toBe(false)
    expect(failure).toMatchObject({
      terminationFailure: true,
      terminationReason: 'timeout',
      outcomeKnown: false,
    })
    expect(command.processExited).toBe(false)
    expect(command.background('btimeout-failure-background')).toBe(true)
    expect(command.status).toBe('backgrounded')

    child.emit('exit', 0, null)
    await command.completion
    command.cleanup()
  })

  test('records timeout termination separately from the observed signal', async () => {
    const child = createChild()
    child.pid = 1236
    const command = wrapTestSpawn(child, 'btimeout-test', {
      timeout: 1,
      processControl: {
        probe: () => 'alive',
        killGroup: () => false,
        killTree: (_pid, callback) => callback(),
      },
    })

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(command.terminationRequested).toBe(true)
    expect(command.terminationReason).toBe('timeout')
    child.emit('exit', null, 'SIGKILL')

    await expect(command.result).resolves.toMatchObject({
      code: 137,
      terminationReason: 'timeout',
    })
    command.cleanup()
  })

  test('calls the timeout background callback instead of terminating', async () => {
    const child = createChild()
    child.pid = 1237
    const command = wrapTestSpawn(child, 'btimeout-background-test', {
      timeout: 1,
      autoBackground: true,
    })
    let callback: ((taskId: string) => boolean) | undefined
    command.onTimeout?.(backgroundFn => {
      callback = backgroundFn
    })

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(command.terminationRequested).toBe(false)
    expect(callback?.('btimeout-background-task')).toBe(true)
    expect(command.status).toBe('backgrounded')
    child.emit('exit', 0, null)
    await command.result
    command.cleanup()
  })

  test('does not background a command after the child has exited', async () => {
    const child = createChild()
    child.pid = 1235
    const command = wrapTestSpawn(child, 'bterminal-background-test')

    child.emit('exit', 0, null)
    await command.result

    expect(command.processExited).toBe(true)
    expect(command.status).toBe('completed')
    expect(command.background('bterminal-background-test')).toBe(false)
    command.cleanup()
  })
})

describe('static ShellCommand results', () => {
  test('creates an already-aborted command with caller metadata', async () => {
    const command = createAbortedCommand('bbackground', { stderr: 'cancelled', code: 130 })

    await expect(command.result).resolves.toMatchObject({
      code: 130,
      stderr: 'cancelled',
      interrupted: true,
      backgroundTaskId: 'bbackground',
    })
    expect(command.status).toBe('killed')
    expect(await command.terminateAndWait(1)).toBe(false)
    expect(command.confirmProcessDisappeared()).toBe(true)
    expect(command.terminationConfirmed).toBe(true)
    expect(command.terminationFailure).toBe(false)
    expect(command.completion).toBe(command.result)
    expect(command.terminationFailureResult).toBe(command.result)
    expect(command.background('another')).toBe(false)
    expect(command.terminationRequested).toBe(false)
    expect(command.terminationReason).toBeUndefined()
    expect(command.processExited).toBe(true)
    expect(await command.waitForExit(1)).toBe(true)
    command.kill()
    command.cleanup()
  })

  test('creates a completed pre-spawn failure result', async () => {
    const command = createFailedCommand('shell missing')

    await expect(command.result).resolves.toMatchObject({
      code: 1,
      stderr: 'shell missing',
      preSpawnError: 'shell missing',
      interrupted: false,
    })
    expect(command.pid).toBeUndefined()
    expect(await command.terminateAndWait(1)).toBe(false)
    expect(command.confirmProcessDisappeared()).toBe(true)
    expect(command.terminationConfirmed).toBe(false)
    expect(command.background('unused')).toBe(false)
    expect(command.terminationRequested).toBe(false)
    expect(command.processExited).toBe(true)
    expect(await command.waitForExit(1)).toBe(true)
    command.kill()
    command.cleanup()
  })
})

describe('killDetachedProcessGroup', () => {
  const originalKill = process.kill

  afterEach(() => {
    process.kill = originalKill
  })

  test('targets the process group for POSIX detached shell commands', () => {
    if (process.platform === 'win32') {
      expect(killDetachedProcessGroup(1234)).toBe(false)
      return
    }

    const calls: Array<{ pid: number, signal: NodeJS.Signals | number | undefined }> = []
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push({ pid, signal })
      return true
    }) as typeof process.kill

    expect(killDetachedProcessGroup(1234)).toBe(true)
    expect(calls).toEqual([{ pid: -1234, signal: 'SIGKILL' }])
  })

  test('treats a missing process group as an already-clean fallback case', () => {
    if (process.platform === 'win32') {
      expect(killDetachedProcessGroup(1234)).toBe(false)
      return
    }

    process.kill = (() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    }) as typeof process.kill

    expect(killDetachedProcessGroup(1234)).toBe(false)
  })
})
