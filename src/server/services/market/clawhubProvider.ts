/**
 * ClawHub provider (https://clawhub.ai)
 *
 * Endpoints (verified against the live API):
 *  - GET /api/v1/skills?limit=&cursor=&sort=downloads → {items, nextCursor}
 *  - GET /api/v1/search?q=                            → {results} (no pagination)
 *  - GET /api/v1/skills/{slug}                        → {skill, latestVersion, owner, metadata, moderation}
 *  - GET /api/v1/skills/{slug}/versions/{v}           → {version:{license, files[], security}}
 *  - GET /api/v1/skills/{slug}/file?path=             → raw file text
 */

import { parseFrontmatter } from '../../../utils/frontmatterParser.js'
import {
  getProviderBase,
  providerFetch,
  providerFetchJson,
  readResponseTextWithLimit,
} from './providerFetch.js'
import {
  detectMarketLanguage,
  MARKET_ERROR_CODES,
  MARKET_LIMITS,
  MarketUpstreamError,
  skillId,
  type MarketProvider,
  type NormalizedSkill,
  type NormalizedSkillDetail,
  type ProviderFileEntry,
  type ProviderListPage,
  type SecurityReport,
  type SecurityStatus,
} from './types.js'

type ClawhubListItem = {
  slug: string
  displayName?: string
  summary?: string
  description?: string
  topics?: string[]
  stats?: { downloads?: number; installs?: number; stars?: number }
  updatedAt?: number
  latestVersion?: { version?: string }
  metadata?: unknown
}

type ClawhubSearchResult = {
  slug: string
  source?: string
  install?: { kind?: string }
  displayName?: string
  summary?: string
  downloads?: number
  updatedAt?: number
  ownerHandle?: string
  owner?: { handle?: string; displayName?: string; image?: string }
}

type ClawhubDetail = {
  skill: ClawhubListItem
  latestVersion?: { version?: string; license?: string }
  owner?: { handle?: string; displayName?: string; image?: string }
  moderation?: unknown
}

type ClawhubVersionDetail = {
  version?: {
    version?: string
    license?: string
    files?: Array<{ path: string; size: number; sha256?: string; contentType?: string }>
    security?: { status?: string; hasWarnings?: boolean; virustotalUrl?: string }
  }
}

// ClawHub slugs are not unique across owners. Ambiguous slugs return
// 409 AMBIGUOUS_SKILL_SLUG with candidate owners; disambiguate via ?owner=
// (first match = primary listing) and remember the resolution.
const ownerCache = new Map<string, string>()

async function clawhubFetch(url: URL, slug: string): Promise<Response> {
  const cachedOwner = ownerCache.get(slug)
  if (cachedOwner && !url.searchParams.has('owner')) {
    url.searchParams.set('owner', cachedOwner)
  }
  const res = await providerFetch('clawhub', url.toString())
  if (res.status !== 409) return res

  const body = (await res.json().catch(() => null)) as
    | { code?: string; matches?: Array<{ ownerHandle?: string }> }
    | null
  const resolvedOwner = body?.code === 'AMBIGUOUS_SKILL_SLUG' ? body.matches?.[0]?.ownerHandle : undefined
  if (!resolvedOwner) {
    throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamError, `clawhub responded 409 for ${url.pathname}`)
  }
  ownerCache.set(slug, resolvedOwner)
  url.searchParams.set('owner', resolvedOwner)
  return providerFetch('clawhub', url.toString())
}

async function clawhubFetchJson<T>(url: URL, slug: string): Promise<T> {
  const res = await clawhubFetch(url, slug)
  if (!res.ok) {
    throw new MarketUpstreamError(
      'clawhub',
      res.status === 404 ? MARKET_ERROR_CODES.upstreamBadResponse : MARKET_ERROR_CODES.upstreamError,
      `clawhub responded ${res.status} for ${url.pathname}`,
    )
  }
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamBadResponse, 'clawhub returned invalid JSON')
  }
}

function mapSecurity(security?: { status?: string; hasWarnings?: boolean; virustotalUrl?: string }): {
  status: SecurityStatus
  reports: SecurityReport[]
} {  if (!security?.status) return { status: 'unknown', reports: [] }
  const clean = security.status === 'clean'
  return {
    status: clean ? 'benign' : 'flagged',
    reports: [
      {
        vendor: 'clawhub-scan',
        status: security.status,
        statusText: clean
          ? security.hasWarnings ? 'Clean (with warnings)' : 'Clean'
          : `Scan status: ${security.status}`,
        reportUrl: security.virustotalUrl,
      },
    ],
  }
}

function normalizeListItem(item: ClawhubListItem): NormalizedSkill {
  return {
    id: skillId('clawhub', item.slug),
    source: 'clawhub',
    slug: item.slug,
    name: item.displayName || item.slug,
    summary: item.summary || '',
    author: { handle: '' },
    stats: {
      downloads: item.stats?.downloads ?? 0,
      installs: item.stats?.installs,
      stars: item.stats?.stars,
    },
    tags: Array.isArray(item.topics) ? item.topics.filter((t): t is string => typeof t === 'string') : [],
    version: item.latestVersion?.version,
    updatedAt: item.updatedAt,
    securityStatus: 'unknown',
    installState: 'installable',
  }
}

function normalizeSearchResult(result: ClawhubSearchResult): NormalizedSkill {
  return {
    id: skillId('clawhub', result.slug),
    source: 'clawhub',
    slug: result.slug,
    name: result.displayName || result.slug,
    summary: result.summary || '',
    author: {
      handle: result.owner?.handle || result.ownerHandle || '',
      displayName: result.owner?.displayName,
      avatarUrl: result.owner?.image,
    },
    stats: { downloads: result.downloads ?? 0 },
    tags: [],
    updatedAt: result.updatedAt,
    securityStatus: 'unknown',
    installState: 'installable',
  }
}

export function resetClawhubOwnerCacheForTests(): void {
  ownerCache.clear()
}

export const clawhubProvider: MarketProvider = {
  source: 'clawhub',

  async list({ cursor, limit }): Promise<ProviderListPage> {
    const base = getProviderBase('clawhub')
    const url = new URL('/api/v1/skills', base)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('sort', 'downloads')
    if (cursor) url.searchParams.set('cursor', cursor)
    const data = await providerFetchJson<{ items?: ClawhubListItem[]; nextCursor?: string }>(
      'clawhub',
      url.toString(),
    )
    if (!Array.isArray(data.items)) {
      throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamBadResponse, 'clawhub list missing items')
    }
    return {
      items: data.items.filter((i) => i?.slug).map(normalizeListItem),
      nextCursor: data.nextCursor || undefined,
    }
  },

  async search({ q, limit }): Promise<ProviderListPage> {
    const base = getProviderBase('clawhub')
    const url = new URL('/api/v1/search', base)
    url.searchParams.set('q', q)
    const data = await providerFetchJson<{ results?: ClawhubSearchResult[] }>('clawhub', url.toString())
    if (!Array.isArray(data.results)) {
      throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamBadResponse, 'clawhub search missing results')
    }
    // Search also aggregates external registries, which cannot use ClawHub's
    // detail/file endpoints. Older native results omit source/install metadata.
    // Filter before capping so external results do not consume native slots.
    const nativeResults = data.results.filter((result) => result?.slug
      && (result.source === undefined || result.source === 'clawhub')
      && (result.install?.kind === undefined || result.install.kind === 'clawhub'))
    return { items: nativeResults.slice(0, limit).map(normalizeSearchResult) }
  },

  async detail(slug): Promise<NormalizedSkillDetail> {
    const base = getProviderBase('clawhub')
    const data = await clawhubFetchJson<ClawhubDetail>(
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, base),
      slug,
    )
    if (!data.skill?.slug) {
      throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamBadResponse, 'clawhub detail missing skill')
    }

    const version = data.latestVersion?.version || data.skill.latestVersion?.version
    let files: ProviderFileEntry[] = []
    let license: string | undefined = data.latestVersion?.license
    let security: { status: SecurityStatus; reports: SecurityReport[] } = { status: 'unknown', reports: [] }
    if (version) {
      try {
        const versionDetail = await clawhubFetchJson<ClawhubVersionDetail>(
          new URL(`/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`, base),
          slug,
        )
        files = versionDetail.version?.files ?? []
        license = versionDetail.version?.license || license
        security = mapSecurity(versionDetail.version?.security)
      } catch {
        // Version detail is best-effort; the skill detail is still useful without files.
      }
    }

    // ClawHub's description IS the SKILL.md content (frontmatter + body).
    const rawDescription = data.skill.description || ''
    let body = rawDescription
    let frontmatter: Record<string, unknown> | undefined
    if (rawDescription.startsWith('---')) {
      try {
        const parsed = parseFrontmatter(rawDescription)
        body = parsed.content
        frontmatter = parsed.frontmatter as Record<string, unknown>
      } catch {
        // Keep raw content when frontmatter parsing fails.
      }
    }

    const item = normalizeListItem(data.skill)
    return {
      ...item,
      version,
      author: {
        handle: data.owner?.handle || '',
        displayName: data.owner?.displayName,
        avatarUrl: data.owner?.image,
      },
      securityStatus: security.status,
      securityReports: security.reports.length ? security.reports : undefined,
      description: body,
      descriptionFrontmatter: frontmatter,
      license,
      files: files.map((f) => ({
        path: f.path,
        size: f.size,
        sha256: f.sha256,
        contentType: f.contentType,
        language: detectMarketLanguage(f.path),
        tooBig: false,
      })),
      totalSize: files.reduce((sum, f) => sum + (f.size || 0), 0),
    }
  },

  async listFiles(slug, version): Promise<ProviderFileEntry[]> {
    const base = getProviderBase('clawhub')
    let resolvedVersion = version
    if (!resolvedVersion) {
      const data = await clawhubFetchJson<ClawhubDetail>(
        new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, base),
        slug,
      )
      resolvedVersion = data.latestVersion?.version || data.skill?.latestVersion?.version
    }
    if (!resolvedVersion) return []
    const versionDetail = await clawhubFetchJson<ClawhubVersionDetail>(
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(resolvedVersion)}`, base),
      slug,
    )
    return versionDetail.version?.files ?? []
  },

  async fetchFile(slug, filePath): Promise<{ content: string; size: number }> {
    const base = getProviderBase('clawhub')
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, base)
    url.searchParams.set('path', filePath)
    const res = await clawhubFetch(url, slug)
    if (!res.ok) {
      throw new MarketUpstreamError(
        'clawhub',
        res.status === 404 ? MARKET_ERROR_CODES.upstreamBadResponse : MARKET_ERROR_CODES.upstreamError,
        `clawhub file fetch failed (${res.status})`,
      )
    }
    return await readResponseTextWithLimit(
      'clawhub',
      res,
      MARKET_LIMITS.maxFileSize,
      `file ${filePath}`,
    )
  },
}
