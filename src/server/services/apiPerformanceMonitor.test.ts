import { describe, expect, it, vi } from 'vitest'
import { ApiPerformanceMonitor } from './apiPerformanceMonitor.js'

const MEMORY = {
  rss: 128 * 1024 * 1024,
  heapTotal: 64 * 1024 * 1024,
  heapUsed: 32 * 1024 * 1024,
  external: 8 * 1024 * 1024,
  arrayBuffers: 4 * 1024 * 1024,
}

describe('ApiPerformanceMonitor', () => {
  it('adds correlation timings and records bounded slow-request metadata', async () => {
    let now = 100
    const recordEvent = vi.fn()
    const monitor = new ApiPerformanceMonitor({
      now: () => now,
      cpuUsage: (previous) => previous ? { user: 15_000, system: 4_000 } : { user: 0, system: 0 },
      memoryUsage: () => MEMORY,
      recordEvent,
      slowRequestMs: 1_000,
    })

    const span = monitor.begin('GET', '/api/sessions')
    now = 1_350
    const response = span.complete(Response.json({ sessions: [] }))
    await Promise.resolve()

    expect(response.headers.get('server-timing')).toBe('app;dur=1250')
    expect(response.headers.get('x-request-id')).toMatch(/^api-/)
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'api_request_slow',
      details: expect.objectContaining({
        path: '/api/sessions',
        route: '/api/sessions',
        durationMs: 1_250,
        cpuUserMs: 15,
        rssMiB: 128,
      }),
    }))
  })

  it('reports an event-loop stall with the requests that were active during it', async () => {
    let now = 0
    let sample: (() => void) | undefined
    const recordEvent = vi.fn()
    const monitor = new ApiPerformanceMonitor({
      now: () => now,
      cpuUsage: () => ({ user: 0, system: 0 }),
      memoryUsage: () => MEMORY,
      recordEvent,
      setInterval: ((callback: TimerHandler) => {
        sample = callback as () => void
        return 1 as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
      eventLoopSampleMs: 1_000,
      eventLoopStallMs: 500,
    })

    monitor.start()
    monitor.begin('GET', '/api/sessions/example/subagents/by-tool/tool-1')
    now = 1_800
    sample?.()
    await Promise.resolve()

    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'server_event_loop_stall',
      details: expect.objectContaining({
        lagMs: 800,
        activeRequests: 1,
        longestActiveRequests: [expect.objectContaining({
          path: '/api/sessions/example/subagents/by-tool/tool-1',
          elapsedMs: 1_800,
        })],
      }),
    }))
  })

  it('never recursively reports a slow diagnostics write', () => {
    let now = 0
    const recordEvent = vi.fn()
    const monitor = new ApiPerformanceMonitor({
      now: () => now,
      cpuUsage: () => ({ user: 0, system: 0 }),
      memoryUsage: () => MEMORY,
      recordEvent,
      slowRequestMs: 1,
    })
    const span = monitor.begin('POST', '/api/diagnostics/events')
    now = 10
    span.complete(new Response(null, { status: 204 }))

    expect(recordEvent).not.toHaveBeenCalled()
  })
})
