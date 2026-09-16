import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  __cursorBadgeIsRunning,
  __resetCursorBadgeState,
  hideCursorBadge,
  showCursorBadge,
} from './winCursorBadge.js'
import { callHelper } from './helperBridge.js'

function childHarness() {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const writes: string[] = []
  let ended = false
  let killed = false
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    exitCode: null,
    stdout,
    stderr,
    stdin: {
      writable: true,
      write: (value: string) => { writes.push(value) },
      end: () => { ended = true },
    },
    kill: () => {
      killed = true
      return true
    },
  })
  Object.defineProperty(child, 'killed', { get: () => killed })
  return { child, stdout, stderr, writes, ended: () => ended }
}

function dependencies(
  spawnChild: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess,
) {
  return {
    platform: 'win32' as const,
    bootstrap: async () => {},
    command: () => ({ python: 'python.exe', script: 'cursor.py' }),
    environment: () => ({ CC_HAHA_COMPUTER_USE_INPUT_TAG: '1234' }),
    spawnChild: spawnChild as typeof import('node:child_process').spawn,
  }
}

async function waitForSpawn(spawned: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10 && !spawned(); attempt++) {
    await Promise.resolve()
  }
  expect(spawned()).toBe(true)
}

afterEach(() => {
  hideCursorBadge()
  __resetCursorBadgeState()
})

describe('Windows virtual cursor process lifecycle', () => {
  test('waits for READY, forwards the action, and reuses the turn process', async () => {
    const harness = childHarness()
    const spawns: Array<{
      file: string
      args: readonly string[]
      options: SpawnOptions
    }> = []
    const deps = dependencies((file, args, options) => {
      spawns.push({ file, args, options })
      return harness.child
    })

    const first = showCursorBadge('click', { x: 40, y: 50, pid: 91 }, deps)
    await waitForSpawn(() => spawns.length === 1)
    expect(harness.writes).toEqual([])
    harness.stdout.emit('data', Buffer.from('READY\r\n'))
    await first

    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({
      file: 'python.exe',
      args: ['cursor.py'],
      options: {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
        env: { CC_HAHA_COMPUTER_USE_INPUT_TAG: '1234' },
      },
    })
    expect(JSON.parse(harness.writes[0])).toEqual({
      command: 'click',
      payload: { x: 40, y: 50, pid: 91 },
      targetPid: 91,
    })
    harness.stderr.emit('data', Buffer.from('diagnostic fixture'))

    await showCursorBadge('move_mouse', { x: 60, y: 70 }, deps)
    expect(spawns).toHaveLength(1)
    expect(JSON.parse(harness.writes[1])).toEqual({
      command: 'move_mouse',
      payload: { x: 60, y: 70 },
    })
    expect(__cursorBadgeIsRunning()).toBe(true)
  })

  test('clears exited children and contains stdin write failures', async () => {
    const harness = childHarness()
    let spawned = false
    const starting = showCursorBadge('move_mouse', { x: 3, y: 4 }, dependencies(() => {
      spawned = true
      return harness.child
    }))
    await waitForSpawn(() => spawned)
    harness.stdout.emit('data', Buffer.from('READY\n'))
    await starting

    const stdin = harness.child.stdin as unknown as { write: (value: string) => void }
    stdin.write = () => { throw new Error('closed pipe') }
    await expect(showCursorBadge(
      'move_mouse',
      { x: 5, y: 6 },
      dependencies(() => { throw new Error('must reuse child') }),
    )).resolves.toBeUndefined()
    expect(__cursorBadgeIsRunning()).toBe(true)

    harness.child.emit('exit', 0, null)
    expect(__cursorBadgeIsRunning()).toBe(false)
  })

  test('turn cleanup closes stdin and terminates the tracked child', async () => {
    const harness = childHarness()
    let spawned = false
    const running = showCursorBadge('scroll', { x: 10, y: 20 }, dependencies(() => {
      spawned = true
      return harness.child
    }))
    await waitForSpawn(() => spawned)
    harness.stdout.emit('data', Buffer.from('READY\n'))
    await running

    hideCursorBadge()

    expect(harness.ended()).toBe(true)
    expect(harness.child.killed).toBe(true)
    expect(__cursorBadgeIsRunning()).toBe(false)
  })

  test('process errors and spawn failures fail open without dispatching input twice', async () => {
    const harness = childHarness()
    let spawned = false
    const starting = showCursorBadge('click', { x: 1, y: 2 }, dependencies(() => {
      spawned = true
      return harness.child
    }))
    await waitForSpawn(() => spawned)
    harness.child.emit('error', new Error('overlay unavailable'))
    await expect(starting).resolves.toBeUndefined()
    expect(harness.writes).toEqual([])
    expect(__cursorBadgeIsRunning()).toBe(false)

    await expect(showCursorBadge('click', {}, dependencies(() => {
      throw new Error('spawn refused')
    }))).resolves.toBeUndefined()
    expect(__cursorBadgeIsRunning()).toBe(false)
  })

  test('non-Windows callers do not bootstrap or spawn the Windows overlay', async () => {
    let bootstrapped = false
    const deps = {
      ...dependencies(() => { throw new Error('must not spawn') }),
      platform: 'darwin' as const,
      bootstrap: async () => { bootstrapped = true },
    }

    await showCursorBadge('click', { x: 1, y: 2 }, deps)

    expect(bootstrapped).toBe(false)
    expect(__cursorBadgeIsRunning()).toBe(false)
  })
})

describe('Windows helper and virtual cursor join', () => {
  test('makes the overlay ready before dispatching an injecting command', async () => {
    const order: string[] = []
    const result = await callHelper<{ ok: boolean }>('click', { x: 8, y: 9 }, {
      platform: 'win32',
      showCursorBadge: async (command, payload) => {
        order.push(`overlay:${command}:${payload.x},${payload.y}`)
      },
      callPy: async () => {
        order.push('input')
        return { ok: true }
      },
    })

    expect(result).toEqual({ ok: true })
    expect(order).toEqual(['overlay:click:8,9', 'input'])
  })

  test('does not start the overlay for a read-only Windows command', async () => {
    let overlayCalls = 0
    await callHelper('screenshot', {}, {
      platform: 'win32',
      showCursorBadge: () => { overlayCalls++ },
      callPy: async () => ({ image: 'fixture' }),
    })
    expect(overlayCalls).toBe(0)
  })
})
