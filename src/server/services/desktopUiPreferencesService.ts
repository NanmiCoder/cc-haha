import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { readRecoverableJsonFile } from './recoverableJsonFile.js'
import { ensurePersistentStorageUpgraded } from './persistentStorageMigrations.js'

const CURRENT_DESKTOP_UI_PREFERENCES_SCHEMA_VERSION = 1
const MAX_PROJECT_PREFERENCE_ENTRIES = 2_000

export type SidebarProjectPreferences = {
  projectOrder: string[]
  pinnedProjects: string[]
  hiddenProjects: string[]
  projectOrganization: 'project' | 'recentProject' | 'time'
  projectSortBy: 'createdAt' | 'updatedAt'
}

export type DesktopUiPreferences = {
  schemaVersion: number
  sidebar: SidebarProjectPreferences
  [key: string]: unknown
}

export type DesktopUiPreferencesReadResult = {
  preferences: DesktopUiPreferences
  exists: boolean
}

const DEFAULT_SIDEBAR_PROJECT_PREFERENCES: SidebarProjectPreferences = {
  projectOrder: [],
  pinnedProjects: [],
  hiddenProjects: [],
  projectOrganization: 'recentProject',
  projectSortBy: 'updatedAt',
}

function defaultPreferences(): DesktopUiPreferences {
  return {
    schemaVersion: CURRENT_DESKTOP_UI_PREFERENCES_SCHEMA_VERSION,
    sidebar: { ...DEFAULT_SIDEBAR_PROJECT_PREFERENCES },
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
    seen.add(item)
    normalized.push(item)
    if (normalized.length >= MAX_PROJECT_PREFERENCE_ENTRIES) break
  }

  return normalized
}

export function normalizeSidebarProjectPreferences(value: unknown): SidebarProjectPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_SIDEBAR_PROJECT_PREFERENCES }
  }

  const record = value as Record<string, unknown>
  return {
    projectOrder: normalizeStringArray(record.projectOrder),
    pinnedProjects: normalizeStringArray(record.pinnedProjects),
    hiddenProjects: normalizeStringArray(record.hiddenProjects),
    projectOrganization: normalizeProjectOrganization(record.projectOrganization),
    projectSortBy: normalizeProjectSortBy(record.projectSortBy),
  }
}

function normalizeProjectOrganization(value: unknown): SidebarProjectPreferences['projectOrganization'] {
  return value === 'project' || value === 'recentProject' || value === 'time' ? value : 'recentProject'
}

function normalizeProjectSortBy(value: unknown): SidebarProjectPreferences['projectSortBy'] {
  return value === 'createdAt' || value === 'updatedAt' ? value : 'updatedAt'
}

function normalizeDesktopUiPreferences(value: unknown): DesktopUiPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  return {
    ...record,
    schemaVersion: CURRENT_DESKTOP_UI_PREFERENCES_SCHEMA_VERSION,
    sidebar: normalizeSidebarProjectPreferences(record.sidebar),
  }
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

export class DesktopUiPreferencesService {
  private static writeLocks = new Map<string, Promise<void>>()

  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getPreferencesPath(): string {
    return path.join(this.getConfigDir(), 'cc-haha', 'desktop-ui.json')
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return false
      throw ApiError.internal(`Failed to access desktop UI preferences: ${error}`)
    }
  }

  private async withWriteLock<T>(
    filePath: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previousWrite = DesktopUiPreferencesService.writeLocks.get(filePath) ?? Promise.resolve()
    const nextWrite = previousWrite.catch(() => {}).then(task)
    const trackedWrite = nextWrite.then(() => {}, () => {})

    DesktopUiPreferencesService.writeLocks.set(filePath, trackedWrite)

    try {
      return await nextWrite
    } finally {
      if (DesktopUiPreferencesService.writeLocks.get(filePath) === trackedWrite) {
        DesktopUiPreferencesService.writeLocks.delete(filePath)
      }
    }
  }

  private async writePreferences(preferences: DesktopUiPreferences): Promise<void> {
    const filePath = this.getPreferencesPath()
    const dir = path.dirname(filePath)
    const contents = JSON.stringify(preferences, null, 2) + '\n'
    const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`

    await fs.mkdir(dir, { recursive: true })

    try {
      await fs.writeFile(tmpFile, contents, 'utf-8')
      await fs.rename(tmpFile, filePath)
    } catch (error) {
      await fs.unlink(tmpFile).catch(() => {})
      throw ApiError.internal(`Failed to write desktop-ui.json: ${error}`)
    }
  }

  async readPreferences(): Promise<DesktopUiPreferencesReadResult> {
    await ensurePersistentStorageUpgraded()
    const filePath = this.getPreferencesPath()
    const existedBeforeRead = await this.fileExists(filePath)
    const preferences = await readRecoverableJsonFile({
      filePath,
      label: 'cc-haha desktop UI preferences',
      defaultValue: defaultPreferences(),
      normalize: normalizeDesktopUiPreferences,
    })
    const existsAfterRead = await this.fileExists(filePath)

    return {
      preferences,
      exists: existedBeforeRead && existsAfterRead,
    }
  }

  async updateSidebarPreferences(sidebar: unknown): Promise<DesktopUiPreferences> {
    const filePath = this.getPreferencesPath()
    return this.withWriteLock(filePath, async () => {
      const { preferences } = await this.readPreferences()
      const nextPreferences: DesktopUiPreferences = {
        ...preferences,
        schemaVersion: CURRENT_DESKTOP_UI_PREFERENCES_SCHEMA_VERSION,
        sidebar: normalizeSidebarProjectPreferences(sidebar),
      }

      await this.writePreferences(nextPreferences)
      return nextPreferences
    })
  }
}
