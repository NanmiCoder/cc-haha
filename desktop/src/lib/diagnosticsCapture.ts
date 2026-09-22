import React from 'react'
import { rawRecordDiagnosticEvent } from '../api/client'

let installed = false
const EVENT_LOOP_SAMPLE_MS = 1_000
const EVENT_LOOP_STALL_MS = 500
const EVENT_LOOP_REPORT_COOLDOWN_MS = 10_000

type RendererPerformanceMonitorDependencies = {
  now?: () => number
  visible?: () => boolean
  record?: typeof rawRecordDiagnosticEvent
  setInterval?: typeof window.setInterval
  clearInterval?: typeof window.clearInterval
}

export function installClientDiagnosticsCapture() {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event) => {
    void reportClientError('client_window_error', event.message || 'Window error', {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: normalizeError(event.error),
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    void reportClientError('client_unhandled_rejection', summarizeUnknown(event.reason), {
      reason: normalizeError(event.reason),
    })
  })

  startRendererPerformanceMonitor()
}

/**
 * A fetch that is slow while this timer remains punctual points at the server;
 * a late timer with otherwise fast transport points at renderer/render work.
 * Only delayed samples are persisted, with a cooldown, so normal operation has
 * no diagnostics traffic and background-tab timer throttling is ignored.
 */
export function startRendererPerformanceMonitor(
  dependencies: RendererPerformanceMonitorDependencies = {},
): () => void {
  const now = dependencies.now ?? (() => performance.now())
  const visible = dependencies.visible ?? (() => document.visibilityState === 'visible')
  const record = dependencies.record ?? rawRecordDiagnosticEvent
  const schedule = dependencies.setInterval ?? window.setInterval.bind(window)
  const cancel = dependencies.clearInterval ?? window.clearInterval.bind(window)
  let expectedAt = now() + EVENT_LOOP_SAMPLE_MS
  let lastReportedAt = Number.NEGATIVE_INFINITY
  const timer = schedule(() => {
    const sampledAt = now()
    const lagMs = Math.max(0, sampledAt - expectedAt)
    expectedAt = sampledAt + EVENT_LOOP_SAMPLE_MS
    if (!visible()) return
    if (
      lagMs < EVENT_LOOP_STALL_MS ||
      sampledAt - lastReportedAt < EVENT_LOOP_REPORT_COOLDOWN_MS
    ) return
    lastReportedAt = sampledAt
    const memory = performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number }
    }
    const toMiB = (bytes: number | undefined) => typeof bytes === 'number'
      ? Math.round(bytes / (1024 * 1024) * 10) / 10
      : null
    void record({
      type: 'client_event_loop_stall',
      severity: 'warn',
      summary: `Renderer event loop was delayed by ${Math.round(lagMs * 10) / 10}ms`,
      details: {
        lagMs: Math.round(lagMs * 10) / 10,
        usedJsHeapMiB: toMiB(memory.memory?.usedJSHeapSize),
        totalJsHeapMiB: toMiB(memory.memory?.totalJSHeapSize),
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
    })
  }, EVENT_LOOP_SAMPLE_MS)
  return () => cancel(timer)
}

export function reportReactError(error: unknown, errorInfo: React.ErrorInfo) {
  return reportClientError('client_react_error_boundary', summarizeUnknown(error), {
    error: normalizeError(error),
    componentStack: errorInfo.componentStack,
  })
}

function reportClientError(type: string, summary: string, details: Record<string, unknown>) {
  return rawRecordDiagnosticEvent({
    type,
    severity: 'error',
    summary,
    details: {
      url: window.location.href,
      userAgent: navigator.userAgent,
      ...details,
    },
  })
}

function summarizeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message || value.name
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeError(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }
  return value
}
