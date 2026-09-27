import { diagnosticsService, type DiagnosticEventInput } from './diagnosticsService.js'

const DEFAULT_SLOW_REQUEST_MS = 1_000
const DEFAULT_EVENT_LOOP_SAMPLE_MS = 1_000
const DEFAULT_EVENT_LOOP_STALL_MS = 500
const DEFAULT_STALL_REPORT_COOLDOWN_MS = 10_000

type ActiveRequest = {
  id: string
  method: string
  path: string
  startedAt: number
  cpuStartedAt: NodeJS.CpuUsage
  concurrentAtStart: number
}

type MonitorDependencies = {
  now?: () => number
  cpuUsage?: (previousValue?: NodeJS.CpuUsage) => NodeJS.CpuUsage
  memoryUsage?: () => NodeJS.MemoryUsage
  recordEvent?: (event: DiagnosticEventInput) => unknown
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
  slowRequestMs?: number
  eventLoopSampleMs?: number
  eventLoopStallMs?: number
  stallReportCooldownMs?: number
}

export type ApiRequestPerformanceSpan = {
  complete(response: Response): Response
  fail(): void
}

function rounded(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10
}

function bytesToMiB(value: number): number {
  return rounded(value / (1024 * 1024))
}

export class ApiPerformanceMonitor {
  private readonly now: () => number
  private readonly cpuUsage: (previousValue?: NodeJS.CpuUsage) => NodeJS.CpuUsage
  private readonly memoryUsage: () => NodeJS.MemoryUsage
  private readonly recordEvent: (event: DiagnosticEventInput) => unknown
  private readonly scheduleInterval: typeof globalThis.setInterval
  private readonly cancelInterval: typeof globalThis.clearInterval
  private readonly slowRequestMs: number
  private readonly eventLoopSampleMs: number
  private readonly eventLoopStallMs: number
  private readonly stallReportCooldownMs: number
  private readonly active = new Map<string, ActiveRequest>()
  private sequence = 0
  private timer: ReturnType<typeof globalThis.setInterval> | undefined
  private nextEventLoopSampleAt = 0
  private lastStallReportAt = Number.NEGATIVE_INFINITY

  constructor(dependencies: MonitorDependencies = {}) {
    this.now = dependencies.now ?? (() => performance.now())
    this.cpuUsage = dependencies.cpuUsage ?? process.cpuUsage.bind(process)
    this.memoryUsage = dependencies.memoryUsage ?? process.memoryUsage.bind(process)
    this.recordEvent = dependencies.recordEvent ?? ((event) => diagnosticsService.recordEvent(event))
    this.scheduleInterval = dependencies.setInterval ?? globalThis.setInterval
    this.cancelInterval = dependencies.clearInterval ?? globalThis.clearInterval
    this.slowRequestMs = dependencies.slowRequestMs ?? DEFAULT_SLOW_REQUEST_MS
    this.eventLoopSampleMs = dependencies.eventLoopSampleMs ?? DEFAULT_EVENT_LOOP_SAMPLE_MS
    this.eventLoopStallMs = dependencies.eventLoopStallMs ?? DEFAULT_EVENT_LOOP_STALL_MS
    this.stallReportCooldownMs = dependencies.stallReportCooldownMs ?? DEFAULT_STALL_REPORT_COOLDOWN_MS
  }

  start(): void {
    if (this.timer) return
    this.nextEventLoopSampleAt = this.now() + this.eventLoopSampleMs
    this.timer = this.scheduleInterval(() => this.sampleEventLoop(), this.eventLoopSampleMs)
    const unref = (this.timer as unknown as { unref?: () => void }).unref
    unref?.call(this.timer)
  }

  stop(): void {
    if (!this.timer) return
    this.cancelInterval(this.timer)
    this.timer = undefined
  }

  begin(method: string, path: string): ApiRequestPerformanceSpan {
    const startedAt = this.now()
    const id = `api-${process.pid}-${Math.trunc(startedAt).toString(36)}-${++this.sequence}`
    const request: ActiveRequest = {
      id,
      method,
      path,
      startedAt,
      cpuStartedAt: this.cpuUsage(),
      concurrentAtStart: this.active.size + 1,
    }
    this.active.set(id, request)
    let settled = false

    return {
      complete: (response) => {
        if (settled) return response
        settled = true
        this.active.delete(id)
        const durationMs = this.now() - startedAt
        const cpu = this.cpuUsage(request.cpuStartedAt)
        const headers = new Headers(response.headers)
        headers.set('Server-Timing', `app;dur=${rounded(durationMs)}`)
        headers.set('X-Request-Id', id)
        if (durationMs >= this.slowRequestMs && !path.startsWith('/api/diagnostics')) {
          const declaredBytes = Number.parseInt(headers.get('content-length') ?? '', 10)
          this.report({
            type: 'api_request_slow',
            severity: 'warn',
            summary: `${method} ${path} took ${rounded(durationMs)}ms`,
            details: {
              requestId: id,
              method,
              path,
              route: path,
              status: response.status,
              durationMs: rounded(durationMs),
              cpuUserMs: rounded(cpu.user / 1_000),
              cpuSystemMs: rounded(cpu.system / 1_000),
              concurrentAtStart: request.concurrentAtStart,
              activeAtFinish: this.active.size,
              declaredResponseBytes: Number.isFinite(declaredBytes) && declaredBytes >= 0
                ? declaredBytes
                : null,
              ...this.memoryDetails(),
            },
          })
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      },
      fail: () => {
        if (settled) return
        settled = true
        this.active.delete(id)
      },
    }
  }

  private sampleEventLoop(): void {
    const sampledAt = this.now()
    const lagMs = Math.max(0, sampledAt - this.nextEventLoopSampleAt)
    this.nextEventLoopSampleAt = sampledAt + this.eventLoopSampleMs
    if (
      lagMs < this.eventLoopStallMs ||
      sampledAt - this.lastStallReportAt < this.stallReportCooldownMs
    ) return
    this.lastStallReportAt = sampledAt
    const longestActiveRequests = [...this.active.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(0, 5)
      .map((request) => ({
        requestId: request.id,
        method: request.method,
        path: request.path,
        elapsedMs: rounded(sampledAt - request.startedAt),
      }))
    this.report({
      type: 'server_event_loop_stall',
      severity: 'warn',
      summary: `Server event loop was delayed by ${rounded(lagMs)}ms`,
      details: {
        lagMs: rounded(lagMs),
        activeRequests: this.active.size,
        longestActiveRequests,
        ...this.memoryDetails(),
      },
    })
  }

  private memoryDetails() {
    const memory = this.memoryUsage()
    return {
      rssMiB: bytesToMiB(memory.rss),
      heapUsedMiB: bytesToMiB(memory.heapUsed),
      externalMiB: bytesToMiB(memory.external),
      arrayBuffersMiB: bytesToMiB(memory.arrayBuffers),
    }
  }

  private report(event: DiagnosticEventInput): void {
    try {
      void Promise.resolve(this.recordEvent(event)).catch(() => undefined)
    } catch {
      // Diagnostics must never make an already slow request fail.
    }
  }
}

export const apiPerformanceMonitor = new ApiPerformanceMonitor()
