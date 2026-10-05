import type { SidebarProjectPreferences } from '../../api/desktopUiPreferences'

/**
 * The sidebar's project preferences (order, pins, hidden projects, grouping,
 * sort) as cached in this browser. The server copy in desktop UI preferences is
 * the source of truth; this cache is what a list shows before that answer
 * arrives. The desktop sidebar writes it, and the phone's session list reads
 * the hidden projects from it so a project hidden on the desktop stays hidden
 * on the phone.
 */

export type SidebarProjectOrganization = 'project' | 'recentProject' | 'time'
export type SidebarProjectSortBy = 'createdAt' | 'updatedAt'

const PROJECT_ORDER_STORAGE_KEY = 'cc-haha-sidebar-project-order'
const PROJECT_PINNED_STORAGE_KEY = 'cc-haha-sidebar-pinned-projects'
const PROJECT_HIDDEN_STORAGE_KEY = 'cc-haha-sidebar-hidden-projects'
const PROJECT_ORGANIZATION_STORAGE_KEY = 'cc-haha-sidebar-project-organization'
const PROJECT_SORT_STORAGE_KEY = 'cc-haha-sidebar-project-sort'

export function readStoredProjectOrder(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

export function writeStoredProjectOrder(projectOrder: string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(projectOrder))
  } catch {
    // Sidebar ordering is a UI preference; ignore storage failures.
  }
}

export function readStoredProjectPins(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_PINNED_STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeStoredProjectPins(projectKeys: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_PINNED_STORAGE_KEY, JSON.stringify([...projectKeys]))
  } catch {
    // Sidebar pinning is a UI preference; ignore storage failures.
  }
}

export function readStoredProjectHidden(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeStoredProjectHidden(projectKeys: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify([...projectKeys]))
  } catch {
    // Hidden projects are a local UI preference; ignore storage failures.
  }
}

export function readStoredProjectOrganization(): SidebarProjectOrganization {
  if (typeof localStorage === 'undefined') return 'recentProject'
  return normalizeProjectOrganization(localStorage.getItem(PROJECT_ORGANIZATION_STORAGE_KEY))
}

export function writeStoredProjectOrganization(organization: SidebarProjectOrganization): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_ORGANIZATION_STORAGE_KEY, organization)
  } catch {
    // Sidebar organization is a UI preference; ignore storage failures.
  }
}

export function readStoredProjectSortBy(): SidebarProjectSortBy {
  if (typeof localStorage === 'undefined') return 'updatedAt'
  return normalizeProjectSortBy(localStorage.getItem(PROJECT_SORT_STORAGE_KEY))
}

export function writeStoredProjectSortBy(sortBy: SidebarProjectSortBy): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_SORT_STORAGE_KEY, sortBy)
  } catch {
    // Sidebar sorting is a UI preference; ignore storage failures.
  }
}

export function buildSidebarProjectPreferences(
  projectOrder: string[],
  pinnedProjectKeys: Set<string>,
  hiddenProjectKeys: Set<string>,
  projectOrganization: SidebarProjectOrganization,
  projectSortBy: SidebarProjectSortBy,
): SidebarProjectPreferences {
  return normalizeSidebarProjectPreferences({
    projectOrder,
    pinnedProjects: [...pinnedProjectKeys],
    hiddenProjects: [...hiddenProjectKeys],
    projectOrganization,
    projectSortBy,
  })
}

export function readCachedSidebarProjectPreferences(): SidebarProjectPreferences {
  return {
    projectOrder: readStoredProjectOrder(),
    pinnedProjects: [...readStoredProjectPins()],
    hiddenProjects: [...readStoredProjectHidden()],
    projectOrganization: readStoredProjectOrganization(),
    projectSortBy: readStoredProjectSortBy(),
  }
}

export function writeCachedSidebarProjectPreferences(preferences: SidebarProjectPreferences): void {
  const normalized = normalizeSidebarProjectPreferences(preferences)
  writeStoredProjectOrder(normalized.projectOrder)
  writeStoredProjectPins(new Set(normalized.pinnedProjects))
  writeStoredProjectHidden(new Set(normalized.hiddenProjects))
  writeStoredProjectOrganization(normalized.projectOrganization)
  writeStoredProjectSortBy(normalized.projectSortBy)
}

export function normalizeSidebarProjectPreferences(preferences: Partial<SidebarProjectPreferences> | undefined): SidebarProjectPreferences {
  return {
    projectOrder: normalizeProjectKeyList(preferences?.projectOrder),
    pinnedProjects: normalizeProjectKeyList(preferences?.pinnedProjects),
    hiddenProjects: normalizeProjectKeyList(preferences?.hiddenProjects),
    projectOrganization: normalizeProjectOrganization(preferences?.projectOrganization),
    projectSortBy: normalizeProjectSortBy(preferences?.projectSortBy),
  }
}

export function normalizeProjectKeyList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }

  return normalized
}

export function hasSidebarProjectPreferences(preferences: SidebarProjectPreferences): boolean {
  return preferences.projectOrder.length > 0
    || preferences.pinnedProjects.length > 0
    || preferences.hiddenProjects.length > 0
    || preferences.projectOrganization !== 'recentProject'
    || preferences.projectSortBy !== 'updatedAt'
}

export function normalizeProjectOrganization(value: unknown): SidebarProjectOrganization {
  return value === 'project' || value === 'recentProject' || value === 'time' ? value : 'recentProject'
}

export function normalizeProjectSortBy(value: unknown): SidebarProjectSortBy {
  return value === 'createdAt' || value === 'updatedAt' ? value : 'updatedAt'
}
