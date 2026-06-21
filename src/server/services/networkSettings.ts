import { SettingsService } from './settingsService.js'

export type NetworkProxyMode = 'system' | 'manual'

export type NetworkSettings = {
  aiRequestTimeoutMs: number
  proxy: {
    mode: NetworkProxyMode
    url: string
  }
}

// aiRequestTimeoutMs is the user-facing "wait for the first reply" budget. It
// drives two CLI knobs in lockstep (see conversationService.buildChildEnv):
//   1. API_TIMEOUT_MS — the SDK client timeout, which on a streaming request
//      only covers connection → response headers (the SDK clears it the moment
//      headers arrive; the streaming body is not covered).
//   2. CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS — the CLI's first-token watchdog,
//      which covers the gap between response headers and the FIRST SSE chunk.
// Together they make the configured timeout span the whole pre-first-token
// window: third-party gateways and local models (sensenova, bailian, zhipu,
// ollama, llama.cpp, ...) often send nothing — not headers, not an SSE ping —
// for minutes while prefilling a large context (#766, #826). Once tokens start
// flowing the CLI hands off to the shorter mid-stream idle watchdog. The
// default matches the SDK's own 600s.
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 600_000
export const MIN_AI_REQUEST_TIMEOUT_MS = 30_000
export const MAX_AI_REQUEST_TIMEOUT_MS = 1_800_000

const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  aiRequestTimeoutMs: DEFAULT_AI_REQUEST_TIMEOUT_MS,
  proxy: {
    mode: 'system',
    url: '',
  },
}

function isNetworkProxyMode(value: unknown): value is NetworkProxyMode {
  return value === 'system' || value === 'manual'
}

function clampTimeoutMs(value: number): number {
  return Math.min(Math.max(value, MIN_AI_REQUEST_TIMEOUT_MS), MAX_AI_REQUEST_TIMEOUT_MS)
}

function parseTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_NETWORK_SETTINGS.aiRequestTimeoutMs
  }
  return clampTimeoutMs(Math.round(value))
}

function parseProxy(value: unknown): NetworkSettings['proxy'] {
  if (!value || typeof value !== 'object') {
    return DEFAULT_NETWORK_SETTINGS.proxy
  }

  const record = value as Record<string, unknown>
  return {
    mode: isNetworkProxyMode(record.mode) ? record.mode : DEFAULT_NETWORK_SETTINGS.proxy.mode,
    url: typeof record.url === 'string' ? record.url.trim() : '',
  }
}

export function normalizeNetworkSettings(settings: unknown): NetworkSettings {
  if (!settings || typeof settings !== 'object') {
    return DEFAULT_NETWORK_SETTINGS
  }

  const record = settings as Record<string, unknown>
  const rawNetwork = record.network
  const network = rawNetwork && typeof rawNetwork === 'object'
    ? rawNetwork as Record<string, unknown>
    : {}

  return {
    aiRequestTimeoutMs: parseTimeoutMs(network.aiRequestTimeoutMs),
    proxy: parseProxy(network.proxy),
  }
}

export function getManualNetworkProxyUrl(settings: NetworkSettings): string | undefined {
  if (settings.proxy.mode !== 'manual') return undefined
  const url = settings.proxy.url.trim()
  return url || undefined
}

export function buildNetworkEnvironment(settings: NetworkSettings): Record<string, string> {
  const env: Record<string, string> = {
    API_TIMEOUT_MS: String(settings.aiRequestTimeoutMs),
  }
  const proxyUrl = getManualNetworkProxyUrl(settings)

  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl
    env.HTTPS_PROXY = proxyUrl
    env.http_proxy = proxyUrl
    env.https_proxy = proxyUrl
  }

  return env
}

export async function loadNetworkSettings(): Promise<NetworkSettings> {
  const settings = await new SettingsService().getUserSettings()
  return normalizeNetworkSettings(settings)
}
