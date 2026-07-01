import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { attachLspProcessLimits, type ResourceSampler } from './lspProcessLimits'

class FakeChild extends EventEmitter {
  pid: number = 1234
  exitCode: number | null = null
  killed: boolean = false
  killCalls: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal)
    this.killed = true
    return true
  }
}

function tickSampler(values: Array<number | null>): ResourceSampler {
  let index = 0
  return async () => {
    const value = values[index++]
    if (value === null || value === undefined) return null
    return { rssBytes: value }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('attachLspProcessLimits (poll-fallback)', () => {
  it('terminates the child after consecutive overages', async () => {
    const child = new FakeChild() as unknown as import('node:child_process').ChildProcess
    const onLimitExceeded = vi.fn()

    const limits = attachLspProcessLimits(
      child,
      {
        maxMemoryBytes: 100,
        sampleIntervalMs: 5,
        consecutiveOveragesToTerminate: 2,
        onLimitExceeded,
      },
      tickSampler([200, 200, 200]),
    )

    expect(limits.strategy).toBe('poll-fallback')

    // Two ticks of 5 ms each plus a small async-flush margin.
    await sleep(30)

    expect(onLimitExceeded).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'memory',
      rssBytes: 200,
    }))
    expect((child as unknown as FakeChild).killCalls).toContain('SIGTERM')

    limits.dispose()
  })

  it('resets the overage counter on a single in-bounds sample', async () => {
    const child = new FakeChild() as unknown as import('node:child_process').ChildProcess
    const onLimitExceeded = vi.fn()

    const limits = attachLspProcessLimits(
      child,
      {
        maxMemoryBytes: 100,
        sampleIntervalMs: 5,
        consecutiveOveragesToTerminate: 2,
        onLimitExceeded,
      },
      tickSampler([200, 50, 200, 50, 200]),
    )

    await sleep(40)

    expect(onLimitExceeded).not.toHaveBeenCalled()
    expect((child as unknown as FakeChild).killCalls).toEqual([])

    limits.dispose()
  })

  it('does not sample after dispose', async () => {
    const child = new FakeChild() as unknown as import('node:child_process').ChildProcess
    const sampler = vi.fn(async () => ({ rssBytes: 0 }))
    const limits = attachLspProcessLimits(
      child,
      { maxMemoryBytes: 100, sampleIntervalMs: 5 },
      sampler,
    )
    limits.dispose()
    await sleep(20)
    expect(sampler).not.toHaveBeenCalled()
  })

  it('skips sampling once the child has exited', async () => {
    const child = new FakeChild() as unknown as import('node:child_process').ChildProcess
    ;(child as unknown as FakeChild).exitCode = 0
    const sampler = vi.fn(async () => ({ rssBytes: 999 }))
    const limits = attachLspProcessLimits(
      child,
      { maxMemoryBytes: 100, sampleIntervalMs: 5, onLimitExceeded: vi.fn() },
      sampler,
    )
    await sleep(20)
    expect(sampler).not.toHaveBeenCalled()
    limits.dispose()
  })

  it('swallows a sampler error and tries again on the next tick', async () => {
    const child = new FakeChild() as unknown as import('node:child_process').ChildProcess
    let calls = 0
    const sampler: ResourceSampler = async () => {
      calls += 1
      if (calls === 1) throw new Error('transient sampler failure')
      return { rssBytes: 0 }
    }
    const limits = attachLspProcessLimits(
      child,
      { maxMemoryBytes: 100, sampleIntervalMs: 5 },
      sampler,
    )
    await sleep(60)
    expect(calls).toBeGreaterThanOrEqual(2)
    limits.dispose()
  })
})
