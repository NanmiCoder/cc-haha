import { describe, expect, test } from 'bun:test'
import {
  killWindowsProcessTree,
  resolveWindowsTaskkillExecutable,
  type WindowsTaskkillSpawnOptions,
} from './windowsProcessTree.js'

describe('resolveWindowsTaskkillExecutable', () => {
  test('uses System32 under SystemRoot, whatever its casing', () => {
    expect(resolveWindowsTaskkillExecutable({ SYSTEMROOT: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe')
    expect(resolveWindowsTaskkillExecutable({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  test('falls back to windir, and never to a bare name a project directory could shadow', () => {
    expect(resolveWindowsTaskkillExecutable({ windir: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(resolveWindowsTaskkillExecutable({ SystemRoot: '' })).toBeNull()
    expect(resolveWindowsTaskkillExecutable({})).toBeNull()
  })
})

describe('killWindowsProcessTree', () => {
  function recordingSpawn(outcome: number | Error) {
    const calls: Array<{ cmd: string[]; options: WindowsTaskkillSpawnOptions }> = []
    const spawn = (cmd: string[], options: WindowsTaskkillSpawnOptions) => {
      calls.push({ cmd, options })
      if (outcome instanceof Error) throw outcome
      return { exited: Promise.resolve(outcome) }
    }
    return { calls, spawn }
  }

  test('runs taskkill /T /F for the pid without a shell and with a hidden window', async () => {
    const taskkill = recordingSpawn(0)

    const stopped = await killWindowsProcessTree(4242, { env: { SystemRoot: 'C:\\Windows' }, spawn: taskkill.spawn })

    expect(stopped).toBe(true)
    expect(taskkill.calls).toEqual([{
      cmd: ['C:\\Windows\\System32\\taskkill.exe', '/PID', '4242', '/T', '/F'],
      options: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true },
    }])
  })

  test('reports failure for a non-zero taskkill exit or a spawn error', async () => {
    const env = { SystemRoot: 'C:\\Windows' }
    expect(await killWindowsProcessTree(4242, { env, spawn: recordingSpawn(128).spawn })).toBe(false)
    expect(await killWindowsProcessTree(4242, { env, spawn: recordingSpawn(new Error('spawn ENOENT')).spawn })).toBe(false)
  })

  test('gives up on a taskkill that never finishes, so the caller can terminate the pid itself', async () => {
    let killed = false
    const hung = () => ({ exited: new Promise<number>(() => {}), kill: () => { killed = true } })

    const stopped = await killWindowsProcessTree(4242, { env: { SystemRoot: 'C:\\Windows' }, spawn: hung, timeoutMs: 20 })

    expect(stopped).toBe(false)
    expect(killed).toBe(true)
  })

  test('never runs taskkill for a missing or invalid pid, or without System32', async () => {
    const taskkill = recordingSpawn(0)
    for (const pid of [undefined, null, 0, -1, 1.5]) {
      expect(await killWindowsProcessTree(pid, { env: { SystemRoot: 'C:\\Windows' }, spawn: taskkill.spawn })).toBe(false)
    }
    expect(await killWindowsProcessTree(4242, { env: {}, spawn: taskkill.spawn })).toBe(false)
    expect(taskkill.calls).toEqual([])
  })
})
