import { getNetworkProxyFetchOptions, getNetworkProxyUrl, loadNetworkSettings, type NetworkSettings } from './networkSettings.js'
import { diagnosticsService, type DiagnosticEventInput } from './diagnosticsService.js'
import { redactSecrets } from '../../services/teamMemorySync/secretScanner.js'

export type RemoteAccessDiagnosticContext = { attemptId?: string }

type Dependencies = RemoteAccessDiagnosticContext & {
  settings?: () => Promise<NetworkSettings>
  fetch?: typeof fetch
  recordDiagnostic?: (input: DiagnosticEventInput) => unknown | Promise<unknown>
}

/** The authenticated control API accepts only a correlation id, never arbitrary log text. */
export function remoteAccessDiagnosticContext(request: Request): RemoteAccessDiagnosticContext {
  const attemptId = request.headers.get('X-CC-Haha-Connection-Attempt')
  return attemptId && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(attemptId) ? { attemptId } : {}
}

function diagnosticError(error: unknown, secrets: string[], seen = new Set<unknown>()): Record<string, unknown> {
  if (!(error instanceof Error) || seen.has(error) || seen.size >= 4) return { name: 'UnknownError' }
  seen.add(error)
  const sanitize = (text: string) => redactSecrets(diagnosticsService.sanitizeString(secrets.reduce((value, secret) => secret ? value.split(secret).join('[REDACTED]') : value, text), 512))
  const record = error as Error & { code?: unknown; syscall?: unknown }
  return {
    name: /^[a-z][a-z0-9_]{0,63}$/i.test(error.name) ? error.name : 'Error',
    description: sanitize(error.message),
    ...(typeof record.code === 'string' && /^[a-z0-9_]{1,64}$/i.test(record.code) ? { code: record.code } : {}),
    ...(typeof record.syscall === 'string' && /^[a-z0-9_]{1,64}$/i.test(record.syscall) ? { syscall: record.syscall } : {}),
    ...(error.cause && !seen.has(error.cause) ? { cause: diagnosticError(error.cause, secrets, seen) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.filter((entry): entry is Error => entry instanceof Error).slice(0, 4).map(entry => diagnosticError(entry, secrets, seen)) } : {}),
  }
}

function proxySecrets(settings: NetworkSettings | undefined): string[] {
  if (!settings?.proxy.url) return []
  try {
    const url = new URL(settings.proxy.url)
    return [settings.proxy.url, decodeURIComponent(url.username), decodeURIComponent(url.password)].filter(Boolean)
  } catch { return [settings.proxy.url] }
}

function recorder(dependencies: Dependencies, type: string) {
  const started = Date.now()
  return async (details: Record<string, unknown>, error?: unknown, settings?: NetworkSettings) => {
    try {
      await (dependencies.recordDiagnostic ?? (input => diagnosticsService.recordEvent(input)))({
        type,
        severity: details.outcome === 'failed' ? 'warn' : 'info',
        summary: `Remote access ${String(details.stage)} ${String(details.outcome)}`,
        details: {
          ...(dependencies.attemptId && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(dependencies.attemptId) ? { attemptId: dependencies.attemptId } : {}),
          durationMs: Date.now() - started,
          ...details,
          ...(error === undefined ? {} : { error: diagnosticError(error, proxySecrets(settings)) }),
        },
      })
    } catch { /* A diagnostic storage failure must not change the connection outcome. */ }
  }
}

/** This result is only delivered over the authenticated loopback control API. */
export async function resolveRemoteAccessProxy(dependencies: Dependencies = {}): Promise<{ proxyUrl: string | null }> {
  const record = recorder(dependencies, 'remote_access_proxy_resolution')
  let settings: NetworkSettings | undefined
  let stage = 'proxy_settings'
  await record({ stage, outcome: 'started' })
  try {
    settings = await (dependencies.settings ?? loadNetworkSettings)()
    stage = 'proxy_resolution'
    const proxyUrl = getNetworkProxyUrl(settings)
    await record({ stage, outcome: 'succeeded', reason: 'proxy_resolved', proxyMode: settings.proxy.mode, proxyUsed: !!proxyUrl })
    return { proxyUrl }
  } catch (error) {
    await record({ stage, outcome: 'failed', reason: settings ? 'proxy_resolution_failed' : 'settings_load_failed', ...(settings ? { proxyMode: settings.proxy.mode } : {}) }, error, settings)
    throw error
  }
}

/** An edge registration alone does not prove that the configured hostname reaches this gateway. */
export async function verifyRemoteAccessGateway(origin: string, gatewayId: string, dependencies: Dependencies = {}): Promise<boolean> {
  const record = recorder(dependencies, 'remote_access_gateway_verification')
  let stage = 'gateway_target_validation'
  let settings: NetworkSettings | undefined
  const metadata: Record<string, unknown> = { timeoutMs: 6000 }
  const failed = async (reason: string, error?: unknown) => {
    await record({ ...metadata, stage, outcome: 'failed', reason }, error, settings)
    return false
  }
  await record({ stage, outcome: 'started' })
  let target: URL
  try { target = new URL('/health', origin) }
  catch (error) {
    await failed('invalid_origin', error)
    throw error
  }
  if (target.protocol !== 'https:' || target.origin !== origin || !gatewayId) return failed('invalid_origin')
  metadata.targetHost = target.hostname
  try {
    stage = 'gateway_proxy_resolution'
    settings = await (dependencies.settings ?? loadNetworkSettings)()
    metadata.proxyMode = settings.proxy.mode
    const fetchOptions = getNetworkProxyFetchOptions(settings, target)
    metadata.proxyUsed = !!fetchOptions.proxy
    stage = 'gateway_request'
    const response = await (dependencies.fetch ?? fetch)(target, {
      ...fetchOptions,
      method: 'GET', redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' },
    })
    stage = 'gateway_response'
    metadata.status = response.status
    // Record the media type only; upstream header parameters can contain arbitrary text.
    metadata.contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? 'missing'
    if (!response.ok) return failed('http_status')
    if (!response.headers.get('content-type')?.includes('application/json')) return failed('unexpected_content_type')
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > 4096) { await response.body?.cancel(); return failed('response_too_large') }
    stage = 'gateway_body_read'
    const reader = response.body?.getReader()
    if (!reader) return failed('empty_body')
    let body = ''
    const decoder = new TextDecoder()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        body += decoder.decode(chunk.value, { stream: true })
        if (body.length > 4096) { await reader.cancel(); return failed('response_too_large') }
      }
      body += decoder.decode()
    } finally { reader.releaseLock() }
    stage = 'gateway_body_parse'
    let value: unknown
    try { value = JSON.parse(body) } catch { return failed('invalid_json') }
    stage = 'gateway_identity'
    if (!value || typeof value !== 'object' || (value as Record<string, unknown>).status !== 'ok') return failed('invalid_health_status')
    if ((value as Record<string, unknown>).gatewayId !== gatewayId) return failed('gateway_identity_mismatch')
    await record({ ...metadata, stage, outcome: 'succeeded', reason: 'verified' })
    return true
  } catch (error) {
    const reason = stage === 'gateway_proxy_resolution' ? 'proxy_resolution_failed' : stage === 'gateway_request' ? 'request_failed' : 'response_read_failed'
    return failed(reason, error)
  }
}
