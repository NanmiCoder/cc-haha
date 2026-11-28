import type { SessionListItem } from '../../types/session'
import {
  getSessionProjectKey,
  normalizePathForCompare,
  projectTitle,
} from '../layout/sidebarTaskGroups'

export type HighlightRange = { start: number; end: number }

export type SearchableProject = {
  key: string
  /** Displayed title: user-customized name if present, else folder basename. */
  title: string
  /** Original folder basename so renamed projects remain findable by folder name. */
  defaultTitle: string
  /** Normalized full path (slashes unified, trailing slash trimmed). */
  path: string
  /** Compact parent/path subtitle shown beside the title when title matched. */
  subtitle: string | null
  workDir: string | null
  sessionCount: number
  archivedCount: number
  modifiedAt: string
  latestSession: SessionListItem | null
}

export type ProjectSearchMatch = SearchableProject & {
  titleHighlights: HighlightRange[]
  displayPath: string | null
  pathHighlights: HighlightRange[]
}

const PATH_SNIPPET_MAX_CHARS = 48

export function buildSearchableProjects(
  sessions: readonly SessionListItem[],
  projectSessionTotals: Readonly<Record<string, number>>,
  projectArchivedTotals: Readonly<Record<string, number>>,
  displayNameForProject: (projectKey: string) => string | null,
): SearchableProject[] {
  const activeByKey = new Map<string, SessionListItem[]>()

  for (const session of sessions) {
    if (session.archived) continue
    const key = getSessionProjectKey(session)
    const list = activeByKey.get(key)
    if (list) list.push(session)
    else activeByKey.set(key, [session])
  }

  const allKeys = new Set<string>(activeByKey.keys())
  for (const [root, count] of Object.entries(projectArchivedTotals)) {
    if (count > 0) allKeys.add(root)
  }

  const projects: SearchableProject[] = []
  for (const key of allKeys) {
    const items = activeByKey.get(key) ?? []
    let latestSession: SessionListItem | null = null
    let latestTime = -1
    for (const item of items) {
      const time = parseTime(item.modifiedAt)
      if (!latestSession || time > latestTime) {
        latestSession = item
        latestTime = time
      }
    }

    const rawRoot = latestSession?.projectRoot || latestSession?.workDir || (key === 'unknown' ? '' : key)
    const defaultTitle = projectTitle(rawRoot || key)
    const title = displayNameForProject(key) || defaultTitle
    const normalizedPath = rawRoot ? normalizePathForCompare(rawRoot) : ''
    const subtitle = rawRoot ? compactProjectPath(rawRoot) : null
    const workDir = rawRoot || latestSession?.workDir || null
    const sessionCount = items.length > 0 ? (projectSessionTotals[key] ?? items.length) : 0
    const archivedCount = projectArchivedTotals[key] ?? 0

    projects.push({
      key,
      title,
      defaultTitle,
      path: normalizedPath,
      subtitle,
      workDir,
      sessionCount,
      archivedCount,
      modifiedAt: latestSession?.modifiedAt ?? '',
      latestSession,
    })
  }

  return projects
}

export function searchProjects(
  projects: readonly SearchableProject[],
  query: string,
  limit = 12,
): ProjectSearchMatch[] {
  const trimmed = query.trim()
  if (!trimmed || limit <= 0) return []

  const lowerQuery = trimmed.toLowerCase()
  const pathQuery = trimmed.replace(/\\/g, '/').toLowerCase()

  const scored: Array<{ match: ProjectSearchMatch; rank: number; modifiedTime: number }> = []

  for (const project of projects) {
    const lowerTitle = project.title.toLowerCase()
    const titleHighlights = findHighlightRanges(project.title, lowerQuery)
    const defaultMatches = project.defaultTitle !== project.title
      ? findHighlightRanges(project.defaultTitle, lowerQuery)
      : []
    const pathMatches = project.path
      ? findHighlightRanges(project.path, pathQuery)
      : []

    let rank: number | null = null
    if (titleHighlights.length > 0) {
      if (lowerTitle === lowerQuery) rank = 0
      else if (titleHighlights[0]!.start === 0) rank = 1
      else rank = 2
    } else if (defaultMatches.length > 0) {
      rank = 3
    } else if (pathMatches.length > 0) {
      rank = 4
    }

    if (rank === null) continue

    let displayPath = project.subtitle
    let pathHighlights: HighlightRange[] = []

    if (titleHighlights.length === 0 && project.path && pathMatches.length > 0) {
      const excerpt = buildPathExcerpt(project.path, pathMatches[0]!)
      displayPath = excerpt.text
      pathHighlights = findHighlightRanges(excerpt.text, pathQuery)
    } else if (titleHighlights.length === 0 && defaultMatches.length > 0) {
      displayPath = project.defaultTitle
      pathHighlights = defaultMatches
    }

    scored.push({
      match: {
        ...project,
        titleHighlights,
        displayPath,
        pathHighlights,
      },
      rank,
      modifiedTime: parseTime(project.modifiedAt),
    })
  }

  scored.sort((a, b) => (
    a.rank - b.rank
    || b.modifiedTime - a.modifiedTime
    || a.match.title.localeCompare(b.match.title)
    || a.match.key.localeCompare(b.match.key)
  ))

  return scored.slice(0, limit).map((item) => item.match)
}

export function findHighlightRanges(text: string, lowerQuery: string): HighlightRange[] {
  if (!text || !lowerQuery) return []
  const lowerText = text.toLowerCase()
  // Guard rare Unicode case-folding length changes so slice indices stay in bounds.
  if (lowerText.length !== text.length) {
    const idx = lowerText.indexOf(lowerQuery)
    if (idx === -1) return []
    const start = Math.min(idx, text.length)
    const end = Math.min(start + lowerQuery.length, text.length)
    return start < end ? [{ start, end }] : []
  }

  const ranges: HighlightRange[] = []
  let from = 0
  while (from <= lowerText.length - lowerQuery.length) {
    const idx = lowerText.indexOf(lowerQuery, from)
    if (idx === -1) break
    ranges.push({ start: idx, end: idx + lowerQuery.length })
    from = idx + lowerQuery.length
  }
  return ranges
}

function compactProjectPath(pathLike: string): string {
  const normalized = normalizePathForCompare(pathLike)
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length <= 3) return normalized
  return `.../${segments.slice(-3, -1).join('/')}`
}

function buildPathExcerpt(fullPath: string, firstHit: HighlightRange): { text: string } {
  if (fullPath.length <= PATH_SNIPPET_MAX_CHARS) return { text: fullPath }
  const matchLen = firstHit.end - firstHit.start
  const remaining = Math.max(0, PATH_SNIPPET_MAX_CHARS - matchLen)
  const before = Math.floor(remaining / 2)
  let start = Math.max(0, firstHit.start - before)
  let end = Math.min(fullPath.length, start + PATH_SNIPPET_MAX_CHARS)
  start = Math.max(0, end - PATH_SNIPPET_MAX_CHARS)

  const prefix = start > 0 ? '…' : ''
  const suffix = end < fullPath.length ? '…' : ''
  return { text: `${prefix}${fullPath.slice(start, end)}${suffix}` }
}

function parseTime(dateStr: string | null | undefined): number {
  if (!dateStr) return 0
  const timestamp = Date.parse(dateStr)
  return Number.isFinite(timestamp) ? timestamp : 0
}
