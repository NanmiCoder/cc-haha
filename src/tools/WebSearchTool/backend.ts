import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { Input, Output, SearchResult } from './WebSearchTool.js'

export type WebSearchMode =
  | 'auto'
  | 'anthropic'
  | 'tavily'
  | 'brave'
  | 'duckduckgo'
  | 'disabled'

export type WebSearchProvider =
  | 'anthropic'
  | 'tavily'
  | 'brave'
  | 'duckduckgo'
  | 'disabled'

export type WebSearchSettings = {
  mode?: WebSearchMode
  tavilyApiKey?: string
  braveApiKey?: string
}

export type ResolvedWebSearch = {
  provider: WebSearchProvider
  settings: WebSearchSettings
}

type ExternalSearchHit = {
  title: string
  url: string
  snippet?: string
}

export type ExternalWebSearchProvider = Exclude<
  WebSearchProvider,
  'anthropic' | 'disabled'
>

const WEB_SEARCH_MODES = new Set<WebSearchMode>([
  'auto',
  'anthropic',
  'tavily',
  'brave',
  'duckduckgo',
  'disabled',
])

const unsupportedNativeModels = new Set<string>()
const DUCKDUCKGO_HTML_ENDPOINT = 'https://html.duckduckgo.com/html'

export function isLikelyClaudeModel(model: string | undefined): boolean {
  if (!model) {
    return false
  }

  return /(^|[/:._-])claude([/:._-]|$)/.test(model.toLowerCase())
}

export function getConfiguredWebSearchSettings(
  settings: Pick<SettingsJson, 'webSearch'> = getSettings_DEPRECATED(),
): WebSearchSettings {
  const raw = settings.webSearch
  if (!raw || typeof raw !== 'object') {
    return {}
  }

  const modeCandidate = raw.mode ?? 'auto'

  return {
    mode: WEB_SEARCH_MODES.has(modeCandidate) ? modeCandidate : 'auto',
    tavilyApiKey: normalizeApiKey(raw.tavilyApiKey),
    braveApiKey: normalizeApiKey(raw.braveApiKey),
  }
}

export function resolveWebSearchProvider(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
): ResolvedWebSearch {
  const mode = settings.mode ?? 'auto'

  if (mode === 'disabled') {
    return { provider: 'disabled', settings }
  }

  if (mode === 'tavily') {
    return { provider: settings.tavilyApiKey ? 'tavily' : 'disabled', settings }
  }

  if (mode === 'brave') {
    return { provider: settings.braveApiKey ? 'brave' : 'disabled', settings }
  }

  if (mode === 'duckduckgo') {
    return { provider: 'duckduckgo', settings }
  }

  if (mode === 'anthropic') {
    return {
      provider: canUseAnthropicNativeWebSearch(model) ? 'anthropic' : 'disabled',
      settings,
    }
  }

  if (canUseAnthropicNativeWebSearch(model)) {
    return { provider: 'anthropic', settings }
  }

  if (settings.tavilyApiKey) {
    return { provider: 'tavily', settings }
  }

  if (settings.braveApiKey) {
    return { provider: 'brave', settings }
  }

  return { provider: 'duckduckgo', settings }
}

export function isWebSearchEnabledForModel(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
): boolean {
  return resolveWebSearchProvider(model, settings).provider !== 'disabled'
}

export function shouldFallbackFromNativeError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error)
  return (
    /\b(400|422)\b/.test(message) ||
    /web_search|server tool|tool schema|input_schema|extra input|unsupported/i.test(
      message,
    )
  )
}

export function markAnthropicNativeUnsupported(model: string | undefined): void {
  const key = normalizeModelKey(model)
  if (key) {
    unsupportedNativeModels.add(key)
  }
}

export async function searchWithExternalProvider(
  provider: ExternalWebSearchProvider,
  input: Input,
  apiKey: string | null,
  signal: AbortSignal,
): Promise<Output> {
  const startTime = performance.now()
  const hits = await searchWithProvider(provider, input, apiKey, signal)
  const durationSeconds = (performance.now() - startTime) / 1000

  return makeExternalSearchOutput(provider, input.query, hits, durationSeconds)
}

export function getExternalFallbackProviders(
  settings: WebSearchSettings,
): ExternalWebSearchProvider[] {
  const mode = settings.mode ?? 'auto'

  if (mode === 'tavily') {
    return settings.tavilyApiKey ? ['tavily'] : []
  }

  if (mode === 'brave') {
    return settings.braveApiKey ? ['brave'] : []
  }

  if (mode === 'duckduckgo') {
    return ['duckduckgo']
  }

  const providers: ExternalWebSearchProvider[] = []
  if (settings.tavilyApiKey) {
    providers.push('tavily')
  }
  if (settings.braveApiKey) {
    providers.push('brave')
  }

  if (mode === 'auto') {
    providers.push('duckduckgo')
  }

  return providers
}

export function getFallbackProvider(
  settings: WebSearchSettings,
): ExternalWebSearchProvider | null {
  return getExternalFallbackProviders(settings)[0] ?? null
}

export function getFallbackProvidersAfter(
  provider: ExternalWebSearchProvider,
  settings: WebSearchSettings,
): ExternalWebSearchProvider[] {
  const providers = getExternalFallbackProviders(settings)
  const index = providers.indexOf(provider)
  return index >= 0 ? providers.slice(index + 1) : []
}

export function getApiKeyForProvider(
  provider: ExternalWebSearchProvider,
  settings: WebSearchSettings,
): string | null {
  if (provider === 'duckduckgo') {
    return null
  }
  return provider === 'tavily'
    ? settings.tavilyApiKey ?? null
    : settings.braveApiKey ?? null
}

export function providerRequiresApiKey(provider: ExternalWebSearchProvider): boolean {
  return provider !== 'duckduckgo'
}

export function makeWebSearchUnavailableOutput(
  query: string,
  durationSeconds: number,
  reason: string,
): Output {
  return {
    query,
    results: [reason],
    durationSeconds,
  }
}

function canUseAnthropicNativeWebSearch(model: string | undefined): boolean {
  const key = normalizeModelKey(model)
  return isLikelyClaudeModel(model) && (!key || !unsupportedNativeModels.has(key))
}

function normalizeModelKey(model: string | undefined): string | null {
  const trimmed = model?.trim().toLowerCase()
  return trimmed || null
}

function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

async function searchWithProvider(
  provider: ExternalWebSearchProvider,
  input: Input,
  apiKey: string | null,
  signal: AbortSignal,
): Promise<ExternalSearchHit[]> {
  if (provider === 'duckduckgo') {
    return searchWithDuckDuckGo(input, signal)
  }

  if (!apiKey) {
    throw new Error(`Web search provider ${provider} requires an API key.`)
  }

  return provider === 'tavily'
    ? searchWithTavily(input, apiKey, signal)
    : searchWithBrave(input, apiKey, signal)
}

async function searchWithTavily(
  input: Input,
  apiKey: string,
  signal: AbortSignal,
): Promise<ExternalSearchHit[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: input.query,
      max_results: 8,
      search_depth: 'basic',
      include_answer: false,
      include_domains: input.allowed_domains,
      exclude_domains: input.blocked_domains,
    }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${await readErrorBody(response)}`)
  }

  const body = (await response.json()) as {
    results?: Array<{ title?: unknown; url?: unknown }>
  }

  return (body.results ?? [])
    .map(hit => normalizeHit(hit.title, hit.url))
    .filter((hit): hit is ExternalSearchHit => hit != null)
}

async function searchWithBrave(
  input: Input,
  apiKey: string,
  signal: AbortSignal,
): Promise<ExternalSearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', applyDomainFiltersToQuery(input))
  url.searchParams.set('count', '8')

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal,
  })

  if (!response.ok) {
    throw new Error(`Brave search failed: ${response.status} ${await readErrorBody(response)}`)
  }

  const body = (await response.json()) as {
    web?: { results?: Array<{ title?: unknown; url?: unknown }> }
  }

  return (body.web?.results ?? [])
    .map(hit => normalizeHit(hit.title, hit.url))
    .filter((hit): hit is ExternalSearchHit => hit != null)
}

async function searchWithDuckDuckGo(
  input: Input,
  signal: AbortSignal,
): Promise<ExternalSearchHit[]> {
  const url = new URL(DUCKDUCKGO_HTML_ENDPOINT)
  url.searchParams.set('q', applyDomainFiltersToQuery(input))

  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    signal,
  })

  if (!response.ok) {
    throw new Error(
      `DuckDuckGo search failed: ${response.status} ${await readErrorBody(response)}`,
    )
  }

  const html = await response.text()
  if (isDuckDuckGoBotChallenge(html)) {
    throw new Error('DuckDuckGo returned a bot-detection challenge.')
  }

  return parseDuckDuckGoHtml(html).slice(0, 8)
}

function applyDomainFiltersToQuery(input: Input): string {
  const allowed = input.allowed_domains?.filter(Boolean) ?? []
  const blocked = input.blocked_domains?.filter(Boolean) ?? []
  const allowedClause = allowed.length
    ? `(${allowed.map(domain => `site:${domain}`).join(' OR ')}) `
    : ''
  const blockedClause = blocked.length
    ? `${blocked.map(domain => `-site:${domain}`).join(' ')} `
    : ''

  return `${allowedClause}${blockedClause}${input.query}`.trim()
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '--')
    .replace(/&hellip;/g, '...')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function readHrefAttribute(tagAttributes: string): string {
  const match = /\bhref=(?:"([^"]*)"|'([^']*)')/i.exec(tagAttributes)
  return match?.[1] ?? match?.[2] ?? ''
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const normalized = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
    const parsed = new URL(normalized)
    return parsed.searchParams.get('uddg') ?? rawUrl
  } catch {
    return rawUrl
  }
}

function isDuckDuckGoBotChallenge(html: string): boolean {
  if (/class=["'][^"']*\bresult__a\b[^"']*["']/i.test(html)) {
    return false
  }
  return /g-recaptcha|are you a human|id=["']challenge-form["']|name=["']challenge["']/i.test(
    html,
  )
}

function parseDuckDuckGoHtml(html: string): ExternalSearchHit[] {
  const results: ExternalSearchHit[] = []
  const resultRegex =
    /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])([^>]*)>([\s\S]*?)<\/a>/gi
  const nextResultRegex =
    /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*>/i
  const snippetRegex =
    /<(?:a|div)\b(?=[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:a|div)>/i

  for (const match of html.matchAll(resultRegex)) {
    const rawAttributes = match[1] ?? ''
    const rawTitle = match[2] ?? ''
    const rawUrl = readHrefAttribute(rawAttributes)
    const matchEnd = (match.index ?? 0) + match[0].length
    const trailingHtml = html.slice(matchEnd)
    const nextResultIndex = trailingHtml.search(nextResultRegex)
    const scopedTrailingHtml =
      nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml
    const rawSnippet = snippetRegex.exec(scopedTrailingHtml)?.[1] ?? ''
    const title = decodeHtmlEntities(stripHtml(rawTitle))
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl))
    const snippet = decodeHtmlEntities(stripHtml(rawSnippet))

    if (title && url) {
      results.push({
        title,
        url,
        ...(snippet ? { snippet } : {}),
      })
    }
  }

  return results
}

function normalizeHit(title: unknown, url: unknown): ExternalSearchHit | null {
  if (typeof title !== 'string' || typeof url !== 'string') {
    return null
  }

  return { title, url }
}

function makeExternalSearchOutput(
  provider: ExternalWebSearchProvider,
  query: string,
  hits: ExternalSearchHit[],
  durationSeconds: number,
): Output {
  const result: SearchResult = {
    tool_use_id: `${provider}-web-search`,
    content: hits,
  }

  return {
    query,
    results: [`Search provider: ${provider}`, result],
    durationSeconds,
  }
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text.slice(0, 500)
}

export const __testing = {
  decodeDuckDuckGoUrl,
  decodeHtmlEntities,
  isDuckDuckGoBotChallenge,
  parseDuckDuckGoHtml,
}
