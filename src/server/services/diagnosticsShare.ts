import type { DiagnosticEvent, DiagnosticSeverity } from './diagnosticsService.js'
import { redactSecrets, scanForSecrets } from '../../services/teamMemorySync/secretScanner.js'

export type SharedDiagnosticEvent = {
  id: string
  timestamp: string
  type: string
  severity: DiagnosticSeverity
  sessionId?: string
  details?: Record<string, unknown>
  omittedFields: string[]
}

export type DiagnosticsIssueReportInput = {
  generatedAt: string
  appInfo: Record<string, unknown>
  providersSummary: Record<string, unknown>
  events: SharedDiagnosticEvent[]
  corruptLineCount: number
}

const CONTENT_BEARING_KEYS = new Set([
  'assistanttext',
  'body',
  'capturedoutput',
  'content',
  'filecontent',
  'filecontents',
  'input',
  'message',
  'messagetext',
  'output',
  'prompt',
  'response',
  'result',
  'sdkmessages',
  'text',
  'toolinput',
  'tooloutput',
  'transcript',
])

const SAFE_SCALAR_KEYS = new Set([
  'activeatfinish',
  'activerequests',
  'arraybuffersmib',
  'attempts',
  'code',
  'concurrentatstart',
  'cpusystemms',
  'cpuuserms',
  'declaredbytes',
  'declaredresponsebytes',
  'durationms',
  'errorcategory',
  'errorcode',
  'fetchms',
  'externalmib',
  'hardwareconcurrency',
  'heapusedmib',
  'is_error',
  'isapierrormessage',
  'iserror',
  'lagms',
  'method',
  'name',
  'recovered',
  'recoveryms',
  'requestid',
  'route',
  'responsechars',
  'responsereadms',
  'rssmib',
  'sdkType'.toLowerCase(),
  'serverappms',
  'status',
  'subtype',
  'suppressedsincelast',
  'timeoutms',
  'totaljsheapmib',
  'usedjsheapmib',
])

const SAFE_METADATA_VALUE_RE = /^[a-z0-9][a-z0-9_.:/ -]{0,127}$/i
const SAFE_API_ROUTE_RE = /^\/api(?:\/[a-z0-9_.:-]{1,64}){1,8}$/i
const MAX_SHARED_IDENTIFIER_LENGTH = 256
const MAX_SHARED_METADATA_LENGTH = 512
const URL_RE = /https?:\/\/[^\s<>"')\]}]+/gi
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const LEGACY_DIAGNOSTIC_SECRET_RE = /\b(?:sk-ant-api03-|sk-proj-|ghp_)[A-Za-z0-9_-]+\b/g
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+/gi
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
const PRIVATE_PATH_RE = /(?:\/Users|\/home|\/private|\/var\/folders|\/tmp)\/[^\s<>"')\]}]+/g
const WINDOWS_PATH_RE = /\b[A-Z]:\\(?:[^\s<>"')\]}]+\\)*[^\s<>"')\]}]*/gi
const SAFE_ERROR_NAMES = new Set([
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
])

export function projectDiagnosticEventForSharing(event: DiagnosticEvent): SharedDiagnosticEvent {
  const omittedFields = ['summary']
  const details = projectDetails(event.details, 'details', omittedFields)
  return {
    id: sanitizeSharedIdentifier(event.id, 'unknown-event', MAX_SHARED_IDENTIFIER_LENGTH),
    timestamp: sanitizeSharedIdentifier(event.timestamp, 'unknown-time', 64),
    type: sanitizeSharedIdentifier(event.type, 'unknown-event-type', 128),
    severity: event.severity,
    ...(event.sessionId
      ? { sessionId: sanitizeSharedIdentifier(event.sessionId, 'unknown-session', MAX_SHARED_IDENTIFIER_LENGTH) }
      : {}),
    ...(details ? { details } : {}),
    omittedFields: [...new Set(omittedFields)].sort(),
  }
}

export function projectProviderSummaryForSharing(
  providersSummary: Record<string, unknown>,
): Record<string, unknown> {
  const providers = Array.isArray(providersSummary.providers)
    ? providersSummary.providers
      .filter((provider): provider is Record<string, unknown> =>
        Boolean(provider) && typeof provider === 'object' && !Array.isArray(provider))
      .slice(0, 100)
    : []
  return {
    activeId: projectProviderScalar(providersSummary.activeId),
    count: providers.length,
    providers: providers.map((provider) => {
      const baseUrl = provider.baseUrl && typeof provider.baseUrl === 'object' && !Array.isArray(provider.baseUrl)
        ? provider.baseUrl as Record<string, unknown>
        : {}
      const models = provider.models && typeof provider.models === 'object' && !Array.isArray(provider.models)
        ? Object.fromEntries(
          Object.entries(provider.models as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string')
            .slice(0, 40)
            .map(([key, value]) => {
              const stringValue = String(value)
              const redacted = scanForSecrets(stringValue).length > 0
              return [
                sanitizeSharedIdentifier(key, 'unknown-model-key', 128),
                redacted
                  ? '[REDACTED]'
                  : sanitizeSharedIdentifier(stringValue, '[REDACTED]', MAX_SHARED_IDENTIFIER_LENGTH),
              ]
            }),
        )
        : {}
      return {
        id: projectProviderScalar(provider.id),
        name: projectProviderScalar(provider.name),
        presetId: projectProviderScalar(provider.presetId),
        apiFormat: projectProviderScalar(provider.apiFormat),
        baseUrl: typeof baseUrl.hostname === 'string'
          ? { hostname: sanitizeSharedIdentifier(baseUrl.hostname, '[REDACTED]', MAX_SHARED_IDENTIFIER_LENGTH) }
          : null,
        models,
      }
    }),
  }
}

export function buildDiagnosticsIssueReport(input: DiagnosticsIssueReportInput): string {
  const eventIds = input.events.map((event) => formatMetadata(event.id)).join(', ') || 'None'
  const providersSummary = projectProviderSummaryForSharing(input.providersSummary)
  const providers = Array.isArray(providersSummary.providers)
    ? providersSummary.providers as Array<Record<string, unknown>>
    : []
  const providerLines = providers.length > 0
    ? providers.map(formatProviderLine)
    : ['- 未配置 Provider']
  const recentErrors = input.events
    .filter((event) => event.severity === 'error' || event.severity === 'warn')
    .slice(0, 50)
  const errorLines = recentErrors.length > 0
    ? recentErrors.map(formatErrorLine)
    : ['- 未记录最近的警告或错误。']
  const corruptionWarning = input.corruptLineCount > 0
    ? `> 警告：检测到 ${input.corruptLineCount} 行损坏的诊断记录，以下信息可能不完整。`
    : '> 未检测到损坏的诊断记录。'

  return [
    `<!-- Generated: ${sanitizeSharedString(input.generatedAt, 128).replace(/-->/g, '-- >')} -->`,
    '',
    '## 问题描述',
    '<!-- 请补充 -->',
    '',
    '- 期望行为: <!-- 请补充 -->',
    '- 出现频率: <!-- 请补充 -->',
    '',
    '## 运行环境',
    `- App: ${formatMetadata(input.appInfo.appVersion)}`,
    `- OS/Arch: ${formatMetadata(input.appInfo.platform)} / ${formatMetadata(input.appInfo.arch)}`,
    `- Bun/Node: ${formatMetadata(input.appInfo.bun)} / ${formatMetadata(input.appInfo.node)}`,
    '- 安装来源: <!-- 请补充 -->',
    '',
    '## Provider / 模型',
    ...providerLines,
    '',
    '## 诊断关联',
    `- Event IDs: ${eventIds}`,
    `- Corrupt diagnostic lines: ${input.corruptLineCount}`,
    '',
    corruptionWarning,
    '',
    '## 复现步骤',
    '1. <!-- 请补充 -->',
    '',
    '## 错误摘要',
    ...errorLines,
    '',
  ].join('\n')
}

function projectDetails(
  value: unknown,
  path: string,
  omittedFields: string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (value !== undefined) omittedFields.push(path)
    return undefined
  }
  if (value instanceof Error) {
    omittedFields.push(`${path}.message`, `${path}.stack`)
    return { error: projectError(value) }
  }

  const projected: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const entryPath = `${path}.${key}`
    const normalizedKey = key.toLowerCase()
    if (CONTENT_BEARING_KEYS.has(normalizedKey)) {
      omittedFields.push(entryPath)
      continue
    }
    if (entry instanceof Error) {
      omittedFields.push(`${entryPath}.message`, `${entryPath}.stack`)
      projected[key] = projectError(entry)
      continue
    }
    if (isSerializedError(entry)) {
      omittedFields.push(`${entryPath}.message`, `${entryPath}.stack`)
      projected[key] = projectSerializedError(entry)
      continue
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const nested = projectDetails(entry, entryPath, omittedFields)
      if (nested && Object.keys(nested).length > 0) projected[key] = nested
      continue
    }
    if (SAFE_SCALAR_KEYS.has(normalizedKey) && isScalar(entry)) {
      projected[key] = normalizedKey === 'route' && typeof entry === 'string'
        ? projectSafeApiRoute(entry)
        : projectSafeMetadataScalar(entry)
      continue
    }
    omittedFields.push(entryPath)
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

function projectError(error: Error): Record<string, string> {
  return {
    name: projectErrorName(error.name),
  }
}

function isSerializedError(value: unknown): value is { name: string; message: string; stack?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return typeof record.name === 'string' && typeof record.message === 'string' &&
    keys.every((key) => key === 'name' || key === 'message' || key === 'stack')
}

function projectSerializedError(error: { name: string; message: string; stack?: string }): Record<string, string> {
  return {
    name: projectErrorName(error.name),
  }
}

function projectErrorName(name: string): string {
  return SAFE_ERROR_NAMES.has(name) ? name : 'UnknownError'
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function projectSafeMetadataScalar(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value !== 'string') return value
  const sanitized = sanitizeSharedString(value, MAX_SHARED_METADATA_LENGTH)
  return SAFE_METADATA_VALUE_RE.test(sanitized) ? sanitized : '[REDACTED]'
}

function projectSafeApiRoute(value: string): string {
  if (!SAFE_API_ROUTE_RE.test(value)) return '[REDACTED]'
  return value
    .split('/')
    .map((segment) => {
      if (
        /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ||
        /^(?:call|toolu)_[a-z0-9_-]{12,}$/i.test(segment)
      ) return ':id'
      return redactSecrets(segment) === segment ? segment : ':redacted'
    })
    .join('/')
}

function sanitizeSharedString(value: string, maxLength = MAX_SHARED_METADATA_LENGTH): string {
  const sanitized = redactSecrets(value.replace(LEGACY_DIAGNOSTIC_SECRET_RE, '[REDACTED]'))
    .replace(URL_RE, (candidate) => {
      try {
        return new URL(candidate).hostname
      } catch {
        return '[REDACTED_URL]'
      }
    })
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(AWS_ACCESS_KEY_RE, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(PRIVATE_PATH_RE, '[REDACTED_PATH]')
    .replace(WINDOWS_PATH_RE, '[REDACTED_PATH]')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized.length > maxLength
    ? `${sanitized.slice(0, maxLength)}...[TRUNCATED]`
    : sanitized
}

function sanitizeSharedIdentifier(value: string, fallback: string, maxLength: number): string {
  return sanitizeSharedString(value, maxLength) || fallback
}

function projectProviderScalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  return sanitizeSharedIdentifier(value, '[REDACTED]', MAX_SHARED_IDENTIFIER_LENGTH)
}

function escapeMarkdownInline(value: string): string {
  return value
    .replace(/[\\`*[\]()<>!~]/g, '\\$&')
    .replace(/@/g, '&#64;')
    .replace(/_/g, (match, offset, string) => {
      // GFM disables intra-word underscore emphasis, so only escape underscores
      // that sit at a word boundary and could actually trigger italics.
      const isWordChar = (char: string | undefined) => char !== undefined && /\w/.test(char)
      if (isWordChar(string[offset - 1]) && isWordChar(string[offset + 1])) return match
      return '&#95;'
    })
}

function formatMetadata(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return escapeMarkdownInline(sanitizeSharedString(String(value)))
  }
  return 'unknown'
}

function formatProviderLine(provider: Record<string, unknown>): string {
  const baseUrl = provider.baseUrl && typeof provider.baseUrl === 'object'
    ? provider.baseUrl as Record<string, unknown>
    : {}
  const models = provider.models && typeof provider.models === 'object' && !Array.isArray(provider.models)
    ? Object.entries(provider.models as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => `${formatMetadata(key)}=${formatMetadata(value)}`)
      .join(', ')
    : 'None'
  return `- ${formatMetadata(provider.name ?? provider.id)} | ${formatMetadata(provider.apiFormat)} | Host: ${formatMetadata(baseUrl.hostname)} | Models: ${models || 'None'}`
}

function formatErrorLine(event: SharedDiagnosticEvent): string {
  const details = event.details ?? {}
  const metadata = [
    typeof details.errorCode === 'string' ? `errorCode=${formatMetadata(details.errorCode)}` : '',
    typeof details.status === 'string' ? `status=${formatMetadata(details.status)}` : '',
  ].filter(Boolean).join(', ')
  return `- ${formatMetadata(event.timestamp)} [${event.severity.toUpperCase()}] ${formatMetadata(event.type)} (${formatMetadata(event.id)})${metadata ? ` — ${metadata}` : ''}`
}
