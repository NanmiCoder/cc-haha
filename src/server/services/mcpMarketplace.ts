/**
 * MCP marketplace service.
 *
 * Surfaces a curated catalog of installable MCP servers to the desktop
 * settings UI. Two data sources, merged by category:
 *
 * 1. **Builtin**: a hand-picked list of commonly used MCP servers shipped
 *    with the app. Always available, never fetched.
 * 2. **Remote**: zero or more user-added URLs that return JSON catalog
 *    payloads (`MarketplaceRemotePayload`). Fetched on demand and cached
 *    on disk so the marketplace works offline.
 *
 * The hardcoded list is deliberately conservative — only servers whose
 * launch command is stable and unambiguous (no shell scripts, no auth
 * prompts) make the cut. Anything more exotic should live in a remote
 * source the user opts into.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { ApiError } from '../middleware/errorHandler.js'

/**
 * Coarse categories surfaced in the marketplace UI. Adding a new category
 * here also requires updating the desktop i18n strings under
 * `settings.mcp.marketplace.category.*` so the section header renders.
 */
export type MarketplaceCategory =
  | 'browser'
  | 'dev-platform'
  | 'data'
  | 'memory'
  | 'search'
  | 'productivity'
  | 'ai'
  | 'utility'

export type MarketplaceTransport =
  | { type: 'stdio'; command: string; args: string[] }
  | { type: 'http' | 'sse'; url: string }

export type MarketplaceEntry = {
  /** Stable identifier; used as the default server name on install. */
  id: string
  /** Display name surfaced in cards. */
  name: string
  /** One-sentence pitch shown below the name. */
  description: string
  category: MarketplaceCategory
  transport: MarketplaceTransport
  /**
   * Environment variables the server expects. The UI prompts for these
   * before saving so users don't install a server that immediately fails.
   */
  requiresEnv?: { name: string; description: string }[]
  /** Source homepage / docs (GitHub README in most cases). */
  homepage?: string
  /**
   * Identifier of the source that produced this entry. `'builtin'` for the
   * hardcoded list; remote source IDs for everything else. Lets the UI
   * group entries by origin and warn users about unknown sources.
   */
  source: string
}

export type MarketplaceRemoteSource = {
  id: string
  url: string
  label?: string
  /** Whether this source contributes entries to the merged catalog. */
  enabled: boolean
}

type RemoteCacheEntry = {
  fetchedAt: number
  entries: MarketplaceEntry[]
  error?: string
}

type MarketplaceConfigFile = {
  version: 1
  remoteSources: MarketplaceRemoteSource[]
  remoteCache?: Record<string, RemoteCacheEntry>
}

export type MarketplaceCatalogResponse = {
  entries: MarketplaceEntry[]
  remoteSources: (MarketplaceRemoteSource & {
    fetchedAt?: number
    error?: string
  })[]
}

/**
 * Schema the user-controlled remote URL must serve. Keep this lightweight
 * so a simple GitHub-hosted JSON file works; extra fields are ignored.
 */
type MarketplaceRemotePayload = {
  name?: string
  version?: number
  entries: MarketplaceEntry[]
}

const CONFIG_FILE = 'mcp-marketplace.json'
const REMOTE_FETCH_TIMEOUT_MS = 10_000
const MAX_REMOTE_PAYLOAD_BYTES = 1_000_000

/**
 * Builtin catalog — keep small and high-signal. Each entry should run with a
 * single command and zero mandatory configuration. Servers needing a token go
 * here only if the env var is well-known and the failure mode is friendly.
 */
const BUILTIN_CATALOG: MarketplaceEntry[] = [
  // ---- browser ----
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    description:
      'Drive a real Chrome instance: navigate, click, screenshot, inspect console and network.',
    category: 'browser',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--isolated'],
    },
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    source: 'builtin',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description:
      'Cross-browser web automation backed by Playwright; ideal for e2e flows.',
    category: 'browser',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    },
    homepage: 'https://github.com/microsoft/playwright-mcp',
    source: 'builtin',
  },

  // ---- dev-platform ----
  // Note: `@modelcontextprotocol/server-github` and `@modelcontextprotocol/
  // server-gitlab` previously lived here. Both moved to the
  // modelcontextprotocol/servers-archived repository on 2025-05-29 and
  // their npm packages are flagged "Package no longer supported". Users
  // were repeatedly hitting `-32000 Connection closed` because the
  // archived snapshots fall over against current MCP clients. Until the
  // upstream replacements (GitHub's official `github-mcp-server` Go
  // binary, GitLab's hosted MCP server) ship a stable `npx`-style
  // launcher we don't ship a one-click install for them.

  // ---- data ----
  {
    id: 'filesystem',
    name: 'Filesystem',
    description:
      'Read and write files inside an explicitly allowlisted directory tree.',
    category: 'data',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    },
    homepage:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    source: 'builtin',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and inspect a SQLite database.',
    category: 'data',
    transport: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-sqlite'],
    },
    homepage:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    source: 'builtin',
  },
  // Note: `@modelcontextprotocol/server-postgres` was removed for the same
  // reason as the GitHub/GitLab entries above — archived upstream, npm
  // package marked "no longer supported", and a known SQL-injection CVE
  // (CVE in v0.6.2) that the maintainers are not patching.

  // ---- memory ----
  {
    id: 'memory',
    name: 'Memory',
    description:
      'Persistent knowledge graph the agent can read and write across sessions.',
    category: 'memory',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    homepage:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    source: 'builtin',
  },

  // ---- search ----
  // Note: `@modelcontextprotocol/server-brave-search` was removed for the
  // same reason as the GitHub/GitLab/Postgres entries above — archived
  // upstream and flagged "Package no longer supported" on npm. Users
  // can still add it manually if their Brave API key works against the
  // archived snapshot.

  // ---- ai ----
  {
    id: 'fetch',
    name: 'Fetch',
    description:
      'Fetch arbitrary URLs and return cleaned-up Markdown for the model.',
    category: 'ai',
    transport: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
    },
    homepage:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    source: 'builtin',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'A thinking-step tool that helps the model plan multi-step tasks.',
    category: 'ai',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    homepage:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    source: 'builtin',
  },
  {
    id: 'context7',
    name: 'Context7',
    description:
      'Pull up-to-date documentation snippets for popular libraries on demand.',
    category: 'ai',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    },
    homepage: 'https://github.com/upstash/context7',
    source: 'builtin',
  },

  // ---- utility ----
  {
    id: 'time',
    name: 'Time',
    description: 'Time and timezone helpers (current time, conversions).',
    category: 'utility',
    transport: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
    },
    homepage:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    source: 'builtin',
  },
  {
    id: 'everything',
    name: 'Everything (demo)',
    description: 'Reference server exercising all MCP capabilities; useful for testing.',
    category: 'utility',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    },
    homepage:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    source: 'builtin',
  },
]

function getMarketplaceConfigPath(): string {
  return path.join(getClaudeConfigHomeDir(), 'cc-haha', CONFIG_FILE)
}

function defaultConfig(): MarketplaceConfigFile {
  return { version: 1, remoteSources: [], remoteCache: {} }
}

async function readConfig(): Promise<MarketplaceConfigFile> {
  const file = getMarketplaceConfigPath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MarketplaceConfigFile>
    return {
      version: 1,
      remoteSources: Array.isArray(parsed.remoteSources)
        ? parsed.remoteSources.filter(isValidRemoteSource)
        : [],
      remoteCache:
        parsed.remoteCache && typeof parsed.remoteCache === 'object'
          ? (parsed.remoteCache as Record<string, RemoteCacheEntry>)
          : {},
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultConfig()
    }
    // Corrupt JSON is treated as missing — preserve forward-compat behaviour
    // observed in providerService / desktopUiPreferencesService.
    return defaultConfig()
  }
}

async function writeConfig(config: MarketplaceConfigFile): Promise<void> {
  const file = getMarketplaceConfigPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(config, null, 2), 'utf-8')
}

function isValidRemoteSource(value: unknown): value is MarketplaceRemoteSource {
  if (!value || typeof value !== 'object') return false
  const v = value as MarketplaceRemoteSource
  return (
    typeof v.id === 'string' &&
    typeof v.url === 'string' &&
    typeof v.enabled === 'boolean'
  )
}

function sanitizeRemoteEntries(
  raw: unknown,
  sourceId: string,
): MarketplaceEntry[] {
  if (!raw || typeof raw !== 'object') return []
  const payload = raw as MarketplaceRemotePayload
  if (!Array.isArray(payload.entries)) return []
  return payload.entries
    .filter((entry): entry is MarketplaceEntry => isValidEntryShape(entry))
    .map((entry) => ({ ...entry, source: sourceId }))
}

function isValidEntryShape(value: unknown): value is MarketplaceEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as MarketplaceEntry
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return false
  if (typeof v.description !== 'string') return false
  if (typeof v.category !== 'string') return false
  if (!v.transport || typeof v.transport !== 'object') return false
  if (v.transport.type === 'stdio') {
    return typeof v.transport.command === 'string' && Array.isArray(v.transport.args)
  }
  if (v.transport.type === 'http' || v.transport.type === 'sse') {
    return typeof v.transport.url === 'string'
  }
  return false
}

async function fetchRemoteSource(
  source: MarketplaceRemoteSource,
): Promise<RemoteCacheEntry> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(source.url, { signal: controller.signal })
    if (!response.ok) {
      return {
        fetchedAt: Date.now(),
        entries: [],
        error: `HTTP ${response.status} ${response.statusText}`,
      }
    }

    // Read with a hard byte cap so a malicious or runaway endpoint can't
    // OOM the server. Streaming would be ideal; cap-and-fail is sufficient
    // for the catalog use case.
    const text = await response.text()
    if (text.length > MAX_REMOTE_PAYLOAD_BYTES) {
      return {
        fetchedAt: Date.now(),
        entries: [],
        error: `Payload too large (>${MAX_REMOTE_PAYLOAD_BYTES} bytes)`,
      }
    }

    const parsed = JSON.parse(text) as unknown
    return {
      fetchedAt: Date.now(),
      entries: sanitizeRemoteEntries(parsed, source.id),
    }
  } catch (error) {
    return {
      fetchedAt: Date.now(),
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function getMarketplaceCatalog(): Promise<MarketplaceCatalogResponse> {
  const config = await readConfig()
  const cache = config.remoteCache ?? {}

  const enabledRemoteEntries = (config.remoteSources ?? [])
    .filter((source) => source.enabled)
    .flatMap((source) => cache[source.id]?.entries ?? [])

  return {
    entries: [...BUILTIN_CATALOG, ...enabledRemoteEntries],
    remoteSources: (config.remoteSources ?? []).map((source) => ({
      ...source,
      fetchedAt: cache[source.id]?.fetchedAt,
      error: cache[source.id]?.error,
    })),
  }
}

export async function refreshMarketplaceSources(
  sourceIds?: string[],
): Promise<MarketplaceCatalogResponse> {
  const config = await readConfig()
  const targets = config.remoteSources.filter((source) => {
    if (!source.enabled) return false
    if (!sourceIds) return true
    return sourceIds.includes(source.id)
  })

  if (targets.length === 0) {
    return getMarketplaceCatalog()
  }

  const results = await Promise.all(
    targets.map(async (source) => [source.id, await fetchRemoteSource(source)] as const),
  )

  const nextCache = { ...(config.remoteCache ?? {}) }
  for (const [id, result] of results) {
    nextCache[id] = result
  }

  await writeConfig({ ...config, remoteCache: nextCache })
  return getMarketplaceCatalog()
}

export async function addMarketplaceSource(input: {
  url: string
  label?: string
  enabled?: boolean
}): Promise<MarketplaceRemoteSource> {
  const url = (input.url ?? '').trim()
  if (!url) {
    throw ApiError.badRequest('Marketplace source URL is required.')
  }
  if (!/^https?:\/\//.test(url)) {
    throw ApiError.badRequest('Marketplace source URL must use http(s).')
  }

  const config = await readConfig()
  if (config.remoteSources.some((source) => source.url === url)) {
    throw ApiError.conflict(`Marketplace source already registered: ${url}`)
  }

  const id = `remote-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const next: MarketplaceRemoteSource = {
    id,
    url,
    label: input.label?.trim() || undefined,
    enabled: input.enabled !== false,
  }

  await writeConfig({
    ...config,
    remoteSources: [...config.remoteSources, next],
  })

  // Eagerly populate the cache so the UI surface is non-empty after add.
  if (next.enabled) {
    await refreshMarketplaceSources([next.id])
  }
  return next
}

export async function removeMarketplaceSource(id: string): Promise<void> {
  const config = await readConfig()
  const filtered = config.remoteSources.filter((source) => source.id !== id)
  if (filtered.length === config.remoteSources.length) {
    throw ApiError.notFound(`Marketplace source not found: ${id}`)
  }

  const nextCache = { ...(config.remoteCache ?? {}) }
  delete nextCache[id]

  await writeConfig({
    ...config,
    remoteSources: filtered,
    remoteCache: nextCache,
  })
}

/** Exposed for tests; do not import in product code. */
export const __test_only__ = {
  BUILTIN_CATALOG,
  getMarketplaceConfigPath,
}
