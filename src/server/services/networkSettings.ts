import { SettingsService } from './settingsService.js'
import { getProxyFetchOptions, getProxyUrl } from '../../utils/proxy.js'
import type { ProviderUseProxy } from '../types/provider.js'

export type NetworkProxyMode = 'direct' | 'system' | 'manual'

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
// default allows 30 minutes for slow local-model reasoning.
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 1_800_000
export const MIN_AI_REQUEST_TIMEOUT_MS = 30_000
// Keep only the JavaScript timer safety boundary, not a product-duration cap.
// Larger delays overflow signed 32-bit timers and can fire almost immediately.
// Use whole seconds to match the desktop input without rounding past the limit.
export const MAX_AI_REQUEST_TIMEOUT_MS = Math.floor(2_147_483_647 / 1000) * 1000
// Floor for the CLI's overall stream-duration cap (CLAUDE_STREAM_MAX_DURATION_MS).
// That cap is what frees an endlessly-trickling provider stream (#766), but it is
// a wall-clock budget that no incoming chunk resets. It must therefore never be
// LOWER than the user's own "请求超时": a local model that legitimately spends
// longer than that thinking or generating would otherwise be killed mid-response
// no matter how far the user raises the timeout (#1307). The floor keeps the
// #766 protection intact when the user configures a very short first-byte budget.
export const MIN_STREAM_MAX_DURATION_MS = 600_000
// Shared by the spawn-time child env and the per-turn hot update so the two
// cannot drift apart.
export function resolveStreamMaxDurationMs(
  apiTimeoutMs: string | number | undefined,
): number {
  return Math.max(MIN_STREAM_MAX_DURATION_MS, Number(apiTimeoutMs) || 0)
}
export const SYSTEM_PROXY_URL_ENV = 'CC_HAHA_SYSTEM_PROXY_URL'
export const SYSTEM_PROXY_ERROR_ENV = 'CC_HAHA_SYSTEM_PROXY_ERROR'

const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  aiRequestTimeoutMs: DEFAULT_AI_REQUEST_TIMEOUT_MS,
  proxy: {
    mode: 'system',
    url: '',
  },
}
const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const

function isNetworkProxyMode(value: unknown): value is NetworkProxyMode {
  return value === 'direct' || value === 'system' || value === 'manual'
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
  const mode = isNetworkProxyMode(record.mode) ? record.mode : DEFAULT_NETWORK_SETTINGS.proxy.mode
  return {
    mode,
    url: mode === 'manual' && typeof record.url === 'string' ? record.url.trim() : '',
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

/**
 * Fold a provider-level three-state override into the global proxy mode.
 *
 * - `inherit` (or a missing/unknown value): keep the global mode.
 * - `off`: force `direct`, bypassing the global proxy (e.g. domestic models
 *   that must not leave through an overseas proxy).
 * - `on`: force a proxied egress. When the global mode is already `system` or
 *   `manual`, keep it. When the global mode is `direct`, borrow the manual URL
 *   if one is present and otherwise fall back to the `system` resolver; if no
 *   proxy URL can be resolved downstream, the callers degrade to direct.
 *
 * Pure function — no I/O, no env reads. This is the NETWORK egress override
 * and has nothing to do with providerNeedsProxy() (protocol transform proxy).
 */
export function resolveEffectiveProxyMode(
  globalSettings: NetworkSettings,
  providerUseProxy?: ProviderUseProxy | null,
): NetworkProxyMode {
  const globalMode = globalSettings.proxy.mode
  if (providerUseProxy === 'off') return 'direct'
  if (providerUseProxy !== 'on') return globalMode
  if (globalMode !== 'direct') return globalMode
  return globalSettings.proxy.url.trim() ? 'manual' : 'system'
}

export function getNetworkProxyUrl(
  settings: NetworkSettings,
  env: NodeJS.ProcessEnv = process.env,
  effectiveMode?: NetworkProxyMode,
): string | null {
  const mode = effectiveMode ?? settings.proxy.mode
  if (mode === 'manual') {
    // Read the URL directly: a provider-forced override can land on 'manual'
    // while settings.proxy.mode still holds the global value.
    const url = settings.proxy.url.trim()
    return url || null
  }
  if (mode === 'system') {
    const bridgeUrl = env[SYSTEM_PROXY_URL_ENV]?.trim()
    if (bridgeUrl) return bridgeUrl

    const bridgeError = env[SYSTEM_PROXY_ERROR_ENV]?.trim()
    if (bridgeError) {
      // A provider-level useProxy='on' override against a global 'direct'
      // setting borrows the system resolver as a fallback. When the resolver
      // failed, no proxy URL is available, so degrade to direct instead of
      // surfacing an error the user never asked for by choosing system mode.
      if (settings.proxy.mode === 'direct') return getProxyUrl(env) ?? null
      throw new Error(bridgeError)
    }

    // Non-Electron/headless server launches have no host resolver bridge. In
    // that environment, "system" retains the conventional process proxy
    // contract. The Electron host clears inherited proxy variables before
    // spawning the server, so desktop requests can only use its bridge.
    return getProxyUrl(env) ?? null
  }
  return null
}

export function mergeLoopbackNoProxy(existing: string | undefined): string {
  const entries = (existing ?? '')
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
  const lowerEntries = new Set(entries.map(entry => entry.toLowerCase()))

  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!lowerEntries.has(entry.toLowerCase())) entries.push(entry)
  }

  return entries.join(',')
}

export function buildNetworkEnvironment(
  settings: NetworkSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
  effectiveMode?: NetworkProxyMode,
): Record<string, string> {
  const env: Record<string, string> = {
    API_TIMEOUT_MS: String(settings.aiRequestTimeoutMs),
  }

  const mode = effectiveMode ?? settings.proxy.mode
  if (mode === 'direct') {
    env.HTTP_PROXY = ''
    env.HTTPS_PROXY = ''
    env.http_proxy = ''
    env.https_proxy = ''
    env.ALL_PROXY = ''
    env.all_proxy = ''
    return env
  }

  const proxyUrl = getNetworkProxyUrl(settings, baseEnv, effectiveMode)

  if (proxyUrl) {
    const noProxy = mergeLoopbackNoProxy(baseEnv.no_proxy || baseEnv.NO_PROXY)
    env.HTTP_PROXY = proxyUrl
    env.HTTPS_PROXY = proxyUrl
    env.http_proxy = proxyUrl
    env.https_proxy = proxyUrl
    env.ALL_PROXY = proxyUrl
    env.all_proxy = proxyUrl
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  } else {
    env.HTTP_PROXY = ''
    env.HTTPS_PROXY = ''
    env.http_proxy = ''
    env.https_proxy = ''
    env.ALL_PROXY = ''
    env.all_proxy = ''
  }

  return env
}

export function getNetworkProxyFetchOptions(
  settings: NetworkSettings,
  targetUrl: string | URL,
  effectiveMode?: NetworkProxyMode,
): ReturnType<typeof getProxyFetchOptions> {
  const noProxy = mergeLoopbackNoProxy(process.env.no_proxy || process.env.NO_PROXY)
  const proxyUrl = getNetworkProxyUrl(settings, process.env, effectiveMode)

  return getProxyFetchOptions({
    proxyUrl,
    targetUrl,
    noProxy,
  })
}

export async function loadNetworkSettings(): Promise<NetworkSettings> {
  const settings = await new SettingsService().getUserSettings()
  return normalizeNetworkSettings(settings)
}
