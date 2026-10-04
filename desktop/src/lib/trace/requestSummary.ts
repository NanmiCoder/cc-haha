import type { TraceCallRecord } from '../../types/trace'
import type { ParsedResponse } from './requestParse'

/** What a reader wants first about one captured model call. */
export type TraceRequestSummary = {
  method?: string
  url?: string
  /** `direct` = the SDK called the provider; `proxy` = the local proxy translated the protocol. */
  route: 'direct' | 'proxy'
  providerName?: string
  providerFormat?: string
  /** Model id the harness asked for. */
  requestedModel?: string
  /** Model id actually sent upstream, when the proxy mapped it to something else. */
  upstreamModel?: string
  /** Model id the provider reported in its response, when it differs from what was sent. */
  respondedModel?: string
  status?: number
  durationMs?: number
  startedAt: string
  requestId?: string
  querySource?: string
}

const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'x-amzn-requestid', 'x-ms-request-id', 'cf-ray']

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function modelOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.model === 'string' && value.model ? value.model : undefined
}

function requestBody(call: TraceCallRecord): unknown {
  if (call.request.semantic?.request) return call.request.semantic.request
  const preview = call.request.body.preview
  if (!preview) return undefined
  try {
    return JSON.parse(preview)
  } catch {
    // A truncated preview is not JSON; the model id is usually near the top.
    const match = /"model"\s*:\s*"([^"]+)"/.exec(preview)
    return match ? { model: match[1] } : undefined
  }
}

function headerValue(headers: Record<string, string> | undefined, names: readonly string[]): string | undefined {
  if (!headers) return undefined
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  for (const name of names) {
    const value = lower.get(name)
    if (value && !/redacted/i.test(value)) return value
  }
  return undefined
}

export function summarizeTraceCall(call: TraceCallRecord, response: ParsedResponse | null): TraceRequestSummary {
  const body = requestBody(call)
  // The proxy records both sides of its translation: `{ anthropic, upstream }`.
  const proxied = isRecord(body) && 'anthropic' in body && 'upstream' in body
  const requestedModel = (proxied ? modelOf(body.anthropic) : modelOf(body)) ?? call.model
  const sentModel = proxied ? modelOf(body.upstream) : requestedModel
  const respondedModel = response?.model
  return {
    method: call.request.method || undefined,
    url: call.request.url || undefined,
    route: call.source === 'proxy' || proxied ? 'proxy' : 'direct',
    providerName: call.provider?.name || undefined,
    providerFormat: call.provider?.format || undefined,
    requestedModel,
    ...(sentModel && sentModel !== requestedModel ? { upstreamModel: sentModel } : {}),
    ...(respondedModel && respondedModel !== (sentModel ?? requestedModel) ? { respondedModel } : {}),
    status: call.response?.status,
    durationMs: call.durationMs,
    startedAt: call.startedAt,
    requestId: headerValue(call.response?.headers, REQUEST_ID_HEADERS),
    querySource: call.querySource,
  }
}
