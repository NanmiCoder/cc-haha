import { logForDebugging } from '../../utils/debug.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { gt } from '../../utils/semver.js'
import { OPENAI_CODEX_CLIENT_VERSION } from './client.js'

/**
 * The Codex models endpoint lists a model only once the caller's
 * `client_version` passes that model's rollout gate, which can be higher than
 * the `minimal_client_version` the entry advertises. Identifying as the latest
 * stable Codex release lets a catalog refresh reveal newly launched models
 * without waiting for a new pinned version; the pinned version stays the floor
 * and the answer whenever no release source is reachable.
 */
export const OPENAI_CODEX_RELEASE_SOURCES = [
  'https://registry.npmjs.org/@openai/codex/latest',
  // Mirrors npm, and is reachable without a proxy where npm is not.
  'https://registry.npmmirror.com/@openai/codex/latest',
] as const

const RELEASE_LOOKUP_TIMEOUT_MS = 3_000
const RELEASE_LOOKUP_TTL_MS = 12 * 60 * 60_000
const RELEASE_LOOKUP_FAILURE_TTL_MS = 10 * 60_000
const STABLE_RELEASE_VERSION = /^\d+\.\d+\.\d+$/

let cached: { version: string; expiresAt: number } | null = null
let lastPublished: string | null = null
let inFlight: Promise<string> | null = null
let generation = 0

async function readPublishedVersion(
  source: string,
  fetchImpl: typeof fetch,
  proxyUrl: string | null | undefined,
): Promise<string> {
  const response = await fetchImpl(source, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(RELEASE_LOOKUP_TIMEOUT_MS),
    ...(proxyUrl === undefined ? {} : getProxyFetchOptions({ proxyUrl, targetUrl: source })),
  })
  if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`)
  const { version } = (await response.json()) as { version?: unknown }
  if (typeof version !== 'string' || !STABLE_RELEASE_VERSION.test(version)) {
    throw new Error(`${source} returned no stable release version`)
  }
  return version
}

async function lookUpReleaseVersion(
  fetchImpl: typeof fetch,
  proxyUrl: string | null | undefined,
): Promise<string> {
  const lookupGeneration = generation
  const results = await Promise.allSettled(
    OPENAI_CODEX_RELEASE_SOURCES.map(source => readPublishedVersion(source, fetchImpl, proxyUrl)),
  )
  const published = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  if (published.length === 0) {
    const reasons = results.map(result => result.status === 'rejected' ? String(result.reason) : '')
    logForDebugging(`[openai] Codex release lookup failed; models use client_version ${lastPublished ?? OPENAI_CODEX_CLIENT_VERSION}: ${reasons.join('; ')}`)
    // A release seen earlier in this process is still a real, newer client.
    const version = lastPublished ?? OPENAI_CODEX_CLIENT_VERSION
    if (lookupGeneration === generation) {
      cached = { version, expiresAt: Date.now() + RELEASE_LOOKUP_FAILURE_TTL_MS }
    }
    return version
  }
  // Sources can lag each other, and the pinned version is the floor.
  const version = published.reduce(
    (highest, candidate) => gt(candidate, highest) ? candidate : highest,
    OPENAI_CODEX_CLIENT_VERSION,
  )
  if (lookupGeneration === generation) {
    lastPublished = version
    cached = { version, expiresAt: Date.now() + RELEASE_LOOKUP_TTL_MS }
  }
  return version
}

/**
 * The Codex version to report to the models endpoint. `forceRefresh` (an
 * explicit catalog refresh) looks the release up again; otherwise a recent
 * answer is reused so background catalog refreshes stay off the registry.
 */
export function resolveOpenAICodexClientVersion(options: {
  fetchOverride?: typeof fetch
  proxyUrl?: string | null
  forceRefresh?: boolean
} = {}): Promise<string> {
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.version)
  }
  if (!inFlight) {
    const lookup = lookUpReleaseVersion(options.fetchOverride ?? globalThis.fetch, options.proxyUrl)
      .finally(() => { if (inFlight === lookup) inFlight = null })
    inFlight = lookup
  }
  return inFlight
}

export function clearOpenAICodexClientVersionCache(): void {
  generation += 1
  cached = null
  lastPublished = null
  inFlight = null
}
