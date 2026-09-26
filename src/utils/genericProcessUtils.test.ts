import { afterEach, describe, expect, test } from 'bun:test'
import { isProcessRunning, probeProcessState } from './genericProcessUtils.js'

describe('process state utilities', () => {
  test('preserves legacy running behavior for invalid and live PIDs', () => {
    expect(probeProcessState(0)).toBe('dead')
    expect(probeProcessState(1)).toBe('dead')
  })

  test('returns false for invalid legacy process checks', () => {
    expect(isProcessRunning(0)).toBe(false)
    expect(isProcessRunning(1)).toBe(false)
  })

  test('returns true when legacy signal probe succeeds', () => {
    const originalKill = process.kill
    process.kill = (() => true) as typeof process.kill
    expect(isProcessRunning(1234)).toBe(true)
    process.kill = originalKill
  })

  test('returns false when legacy signal probe fails', () => {
    const originalKill = process.kill
    process.kill = (() => { throw new Error('missing') }) as typeof process.kill
    expect(isProcessRunning(1234)).toBe(false)
    process.kill = originalKill
  })

  test('distinguishes ESRCH from other probe failures', () => {
    const originalKill = process.kill
    process.kill = (() => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }) }) as typeof process.kill
    expect(probeProcessState(1234)).toBe('dead')
    process.kill = (() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }) as typeof process.kill
    expect(probeProcessState(1234)).toBe('unknown')
    process.kill = originalKill
  })
})

describe('probeProcessState', () => {
  const originalKill = process.kill

  afterEach(() => {
    process.kill = originalKill
  })

  test('returns dead for invalid and protected init PIDs', () => {
    expect(probeProcessState(0)).toBe('dead')
    expect(probeProcessState(1)).toBe('dead')
  })

  test('returns alive when signal zero succeeds', () => {
    process.kill = (() => true) as typeof process.kill

    expect(probeProcessState(1234)).toBe('alive')
  })

  test('distinguishes missing processes from probe failures', () => {
    process.kill = (() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    }) as typeof process.kill
    expect(probeProcessState(1234)).toBe('dead')

    process.kill = (() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    }) as typeof process.kill
    expect(probeProcessState(1234)).toBe('unknown')
  })
})
