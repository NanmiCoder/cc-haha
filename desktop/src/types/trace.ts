export type TraceBodySnapshot = {
  contentType: 'json' | 'text' | 'empty'
  bytes: number
  sha256: string
  preview: string
  truncated: boolean
}

export type TraceProviderInfo = {
  id: string | null
  name: string
  format: string
}

export type TraceCallStatus = 'pending' | 'ok' | 'error'
export type TraceEventSeverity = 'info' | 'warning' | 'error'

export type TraceCallUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export type TraceCallRecord = {
  id: string
  sessionId: string
  source: 'anthropic' | 'proxy'
  querySource?: string
  provider?: TraceProviderInfo
  model?: string
  status?: TraceCallStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  usage?: TraceCallUsage
  metadata?: Record<string, unknown>
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body: TraceBodySnapshot
  }
  response?: {
    status: number
    headers: Record<string, string>
    body: TraceBodySnapshot
  }
  error?: {
    name: string
    message: string
    code?: string
    stack?: string
    cause?: string
  }
}

export type TraceEventRecord = {
  id: string
  sessionId: string
  timestamp: string
  phase: string
  severity: TraceEventSeverity
  callId?: string
  source?: TraceCallRecord['source']
  provider?: TraceProviderInfo
  model?: string
  title?: string
  message?: string
  metadata?: Record<string, unknown>
}

export type TraceSessionSummary = {
  apiCalls: number
  failedCalls: number
  totalDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  models: Array<{ model: string; calls: number }>
  updatedAt: string | null
}

export type TraceSession = {
  sessionId: string
  session?: {
    id: string
    title: string
    projectPath: string
    workDir: string | null
  } | null
  summary: TraceSessionSummary
  calls: TraceCallRecord[]
  events?: TraceEventRecord[]
}

export type TraceCaptureSettings = {
  enabled: boolean
  storageDir: string
}

export type TraceSessionListItem = {
  sessionId: string
  session: {
    id: string
    title: string
    projectPath: string
    workDir: string | null
  } | null
  summary: TraceSessionSummary
  fileSize: number
  fileUpdatedAt: string
}

export type TraceSessionList = {
  traces: TraceSessionListItem[]
  total: number
  storageDir: string
  settings: TraceCaptureSettings
}
