import { normalizeClawHubList } from './clawhubAdapter.js'
import { normalizeSkillHubList } from './skillhubAdapter.js'
import type { SkillMarketItem, SkillMarketListResult } from './types.js'

export type SkillMarketListSource = 'auto' | 'clawhub' | 'skillhub'

export type SkillMarketListParams = {
  source?: SkillMarketListSource
  limit?: number
  query?: string
  cursor?: string
  sort?: 'downloads' | 'installs' | 'stars' | 'updated' | 'trending'
}

type FetchImpl = typeof fetch
type InstalledSkillNamesProvider = Set<string> | (() => Set<string> | Promise<Set<string>>)

export type SkillMarketServiceOptions = {
  fetchImpl?: FetchImpl
  installedSkillNames?: InstalledSkillNamesProvider
}

export type SkillMarketService = {
  listSkills: (params?: SkillMarketListParams) => Promise<SkillMarketListResult>
  list: (params?: SkillMarketListParams) => Promise<SkillMarketListResult>
}

const CLAWHUB_SKILLS_URL = 'https://clawhub.ai/api/v1/skills'
const SKILLHUB_SKILLS_URL = 'https://api.skillhub.cn/api/skills'
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

export function createSkillMarketService(options: SkillMarketServiceOptions = {}): SkillMarketService {
  const fetchImpl = options.fetchImpl ?? fetch
  const installedSkillNames = options.installedSkillNames

  async function listSkills(params: SkillMarketListParams = {}): Promise<SkillMarketListResult> {
    const source = params.source ?? 'auto'

    if (source === 'clawhub') {
      return withInstalled(await listClawHub(params))
    }

    if (source === 'skillhub') {
      return withInstalled(await listSkillHub(params, 'ok'))
    }

    if (source !== 'auto') {
      throw new Error(`Unsupported skill market source: ${source}`)
    }

    try {
      return withInstalled(await listClawHub(params))
    } catch (error) {
      const fallback = await listSkillHub(params, 'fallback')
      return withInstalled({
        ...fallback,
        sourceStatus: 'fallback',
        message: `ClawHub unavailable: ${errorMessage(error)}`,
      })
    }
  }

  async function listClawHub(params: SkillMarketListParams): Promise<SkillMarketListResult> {
    const url = new URL(CLAWHUB_SKILLS_URL)
    url.searchParams.set('sort', clawHubSort(params.sort))
    url.searchParams.set('nonSuspiciousOnly', 'true')
    url.searchParams.set('limit', String(limitFor(params.limit)))
    addOptionalParam(url, 'query', params.query)
    addOptionalParam(url, 'cursor', params.cursor)

    const payload = await requestJson(fetchImpl, url, 'ClawHub')
    return normalizeClawHubList(payload)
  }

  async function listSkillHub(
    params: SkillMarketListParams,
    sourceStatus: SkillMarketListResult['sourceStatus'],
  ): Promise<SkillMarketListResult> {
    const url = new URL(SKILLHUB_SKILLS_URL)
    url.searchParams.set('sortBy', skillHubSort(params.sort))
    url.searchParams.set('order', 'desc')
    url.searchParams.set('limit', String(limitFor(params.limit)))
    addOptionalParam(url, 'query', params.query)
    addOptionalParam(url, 'cursor', params.cursor)

    const payload = await requestJson(fetchImpl, url, 'SkillHub')
    return {
      ...normalizeSkillHubList(payload),
      sourceStatus,
    }
  }

  async function withInstalled(result: SkillMarketListResult): Promise<SkillMarketListResult> {
    const installed = await resolveInstalledSkillNames(installedSkillNames)
    return {
      ...result,
      items: result.items.map((item): SkillMarketItem => ({
        ...item,
        installed: installed.has(item.slug),
      })),
    }
  }

  return {
    listSkills,
    list: listSkills,
  }
}

async function requestJson(fetchImpl: FetchImpl, url: URL, sourceName: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    throw new Error(`${sourceName} request failed: ${errorMessage(error)}`)
  }

  if (!response.ok) {
    throw new Error(`${sourceName} request failed with status ${response.status}`)
  }

  return response.json()
}

async function resolveInstalledSkillNames(provider?: InstalledSkillNamesProvider): Promise<Set<string>> {
  if (!provider) {
    return new Set()
  }
  if (provider instanceof Set) {
    return provider
  }
  return provider()
}

function limitFor(limit: number | undefined): number {
  if (!Number.isInteger(limit) || limit === undefined || limit < 1) {
    return DEFAULT_LIMIT
  }
  return Math.min(limit, MAX_LIMIT)
}

function clawHubSort(sort: SkillMarketListParams['sort']): string {
  if (sort === 'updated') {
    return 'updated'
  }
  if (sort === 'installs' || sort === 'stars' || sort === 'trending') {
    return sort
  }
  return 'downloads'
}

function skillHubSort(sort: SkillMarketListParams['sort']): string {
  if (sort === 'updated') {
    return 'updated_at'
  }
  if (sort === 'installs' || sort === 'stars') {
    return sort
  }
  return 'downloads'
}

function addOptionalParam(url: URL, name: string, value: string | undefined) {
  const trimmed = value?.trim()
  if (trimmed) {
    url.searchParams.set(name, trimmed)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
