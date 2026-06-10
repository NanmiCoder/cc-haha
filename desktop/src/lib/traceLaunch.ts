export type TraceLaunchRequest = {
  sessionId: string | null
  windowMode: boolean
}

function normalizeTraceSessionId(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function isTruthyParam(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

export function getTraceLaunchRequest(search = window.location.search): TraceLaunchRequest {
  const params = new URLSearchParams(search)
  return {
    sessionId: normalizeTraceSessionId(
      params.get('traceSessionId') ?? params.get('sessionId'),
    ),
    windowMode: isTruthyParam(params.get('traceWindow')),
  }
}

export function buildTraceWindowUrl(sessionId: string, currentHref = window.location.href): string {
  const url = new URL(currentHref)
  url.searchParams.set('traceWindow', '1')
  url.searchParams.set('traceSessionId', sessionId)
  return url.toString()
}
