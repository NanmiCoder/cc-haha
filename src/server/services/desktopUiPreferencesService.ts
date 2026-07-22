import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { readRecoverableJsonFile } from './recoverableJsonFile.js'
import { ensurePersistentStorageUpgraded } from './persistentStorageMigrations.js'

const CURRENT_DESKTOP_UI_PREFERENCES_SCHEMA_VERSION = 4
const MAX_PROJECT_PREFERENCE_ENTRIES = 2_000
const MAX_PROFILE_DISPLAY_NAME_LENGTH = 80
const MAX_PROFILE_SUBTITLE_LENGTH = 160
const MAX_PROFILE_AVATAR_BYTES = 2_000_000
const MAX_PET_ID_LENGTH = 80
const MIN_PET_SIZE = 96
const MAX_PET_SIZE = 192
const DEFAULT_PET_SIZE = 144
const MAX_PET_SESSION_ID_LENGTH = 200
const DEFAULT_PROFILE_SUBTITLE = 'github.com/NanmiCoder/cc-haha'
const DEFAULT_PET_ID = 'dada-code'

const AVATAR_CONTENT_TYPES = {
  'image/png': { extension: 'png', mediaType: 'image/png' },
  'image/jpeg': { extension: 'jpg', mediaType: 'image/jpeg' },
  'image/webp': { extension: 'webp', mediaType: 'image/webp' },
} as const

export type SidebarProjectPreferences = {
  projectOrder: string[]
  pinnedProjects: string[]
  hiddenProjects: string[]
  projectOrganization: 'project' | 'recentProject' | 'time'
  projectSortBy: 'createdAt' | 'updatedAt'
}

export type DesktopProfilePreferences = {
  displayName: string
  subtitle: string
  avatarFile: string | null
  avatarUpdatedAt: string | null
}

export type DesktopPetPreferences = {
  enabled: boolean
  selectedPetId: string
  size: number
  showTaskPanel: boolean
  collapsed: boolean
  motionEnabled: boolean
  lastSessionId: string | null
}

export type DesktopUiPreferences = {
  schemaVersion: number
  sidebar: SidebarProjectPreferences
  profile: DesktopProfilePreferences
  pet: DesktopPetPreferences
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

const DEFAULT_PROFILE_PREFERENCES: DesktopProfilePreferences = {
  displayName: 'cc-haha',
  subtitle: DEFAULT_PROFILE_SUBTITLE,
  avatarFile: null,
  avatarUpdatedAt: null,
}

const DEFAULT_PET_PREFERENCES: DesktopPetPreferences = {
  enabled: false,
  selectedPetId: DEFAULT_PET_ID,
  size: DEFAULT_PET_SIZE,
  showTaskPanel: false,
  collapsed: false,
  motionEnabled: true,
  lastSessionId: null,
}

function defaultPreferences(): DesktopUiPreferences {
  return {
    schemaVersion: CURRENT_DESKTOP_UI_PREFERENCES_SCHEMA_VERSION,
    sidebar: { ...DEFAULT_SIDEBAR_PROJECT_PREFERENCES },
    profile: { ...DEFAULT_PROFILE_PREFERENCES },
    pet: { ...DEFAULT_PET_PREFERENCES },
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
    ...record,
    projectOrder: normalizeStringArray(record.projectOrder),
    pinnedProjects: normalizeStringArray(record.pinnedProjects),
    hiddenProjects: normalizeStringArray(record.hiddenProjects),
    projectOrganization: normalizeProjectOrganization(record.projectOrganization),
    projectSortBy: normalizeProjectSortBy(record.projectSortBy),
  }
}

function normalizeProfileDisplayName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PROFILE_PREFERENCES.displayName
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return DEFAULT_PROFILE_PREFERENCES.displayName
  return trimmed.slice(0, MAX_PROFILE_DISPLAY_NAME_LENGTH)
}

function normalizeProfileSubtitle(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PROFILE_PREFERENCES.subtitle
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return DEFAULT_PROFILE_PREFERENCES.subtitle
  return trimmed.slice(0, MAX_PROFILE_SUBTITLE_LENGTH)
}

function normalizeAvatarFile(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!/^profile\/avatar\.(png|jpg|webp)$/.test(value)) return null
  return value
}

function normalizeProfilePreferences(value: unknown): DesktopProfilePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_PROFILE_PREFERENCES }
  }

  const record = value as Record<string, unknown>
  return {
    ...record,
    displayName: normalizeProfileDisplayName(record.displayName),
    subtitle: normalizeProfileSubtitle(record.subtitle),
    avatarFile: normalizeAvatarFile(record.avatarFile),
    avatarUpdatedAt: typeof record.avatarUpdatedAt === 'string' ? record.avatarUpdatedAt : null,
  }
}

function normalizePetId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PET_ID
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PET_ID_LENGTH ||
    !/^(?:custom:)?[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)
  ) {
    return DEFAULT_PET_ID
  }
  return trimmed
}

function normalizePetSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_PET_SIZE
  return Math.min(MAX_PET_SIZE, Math.max(MIN_PET_SIZE, value))
}

function normalizePetSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, MAX_PET_SESSION_ID_LENGTH) : null
}

export function normalizeDesktopPetPreferences(value: unknown): DesktopPetPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_PET_PREFERENCES }
  }

  const record = value as Record<string, unknown>
  return {
    ...record,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_PET_PREFERENCES.enabled,
    selectedPetId: normalizePetId(record.selectedPetId),
    size: normalizePetSize(record.size),
    showTaskPanel: typeof record.showTaskPanel === 'boolean'
      ? record.showTaskPanel
      : DEFAULT_PET_PREFERENCES.showTaskPanel,
    collapsed: typeof record.collapsed === 'boolean' ? record.collapsed : DEFAULT_PET_PREFERENCES.collapsed,
    motionEnabled: typeof record.motionEnabled === 'boolean'
      ? record.motionEnabled
      : DEFAULT_PET_PREFERENCES.motionEnabled,
    lastSessionId: normalizePetSessionId(record.lastSessionId),
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
  const sourceSchemaVersion = record.schemaVersion
  return {
    ...record,
    schemaVersion: typeof sourceSchemaVersion === 'number'
      && Number.isSafeInteger(sourceSchemaVersion)
      && sourceSchemaVersion > CURRENT_DESKTOP_UI_PREFERENCES_SCHEMA_VERSION
      ? sourceSchemaVersion
      : CURRENT_DESKTOP_UI_PREFERENCES_SCHEMA_VERSION,
    sidebar: normalizeSidebarProjectPreferences(record.sidebar),
    profile: normalizeProfilePreferences(record.profile),
    pet: normalizeDesktopPetPreferences(record.pet),
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

  private getProfileDir(): string {
    return path.join(this.getConfigDir(), 'cc-haha', 'profile')
  }

  private getProfileAvatarPath(avatarFile: string): string {
    const normalized = normalizeAvatarFile(avatarFile)
    if (!normalized) {
      throw ApiError.badRequest('Invalid avatar file path')
    }
    return path.join(this.getConfigDir(), 'cc-haha', normalized)
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
      const sidebarPatch = sidebar && typeof sidebar === 'object' && !Array.isArray(sidebar)
        ? sidebar as Record<string, unknown>
        : {}
      const nextPreferences: DesktopUiPreferences = {
        ...preferences,
        schemaVersion: preferences.schemaVersion,
        sidebar: normalizeSidebarProjectPreferences({
          ...preferences.sidebar,
          ...sidebarPatch,
        }),
        profile: normalizeProfilePreferences(preferences.profile),
        pet: normalizeDesktopPetPreferences(preferences.pet),
      }

      await this.writePreferences(nextPreferences)
      return nextPreferences
    })
  }

  async updateProfilePreferences(profile: unknown): Promise<DesktopUiPreferences> {
    const filePath = this.getPreferencesPath()
    return this.withWriteLock(filePath, async () => {
      const { preferences } = await this.readPreferences()
      const currentProfile = normalizeProfilePreferences(preferences.profile)
      const patch = profile && typeof profile === 'object' && !Array.isArray(profile)
        ? profile as Record<string, unknown>
        : {}
      const nextProfile = normalizeProfilePreferences({
        ...currentProfile,
        displayName: Object.prototype.hasOwnProperty.call(patch, 'displayName')
          ? patch.displayName
          : currentProfile.displayName,
        subtitle: Object.prototype.hasOwnProperty.call(patch, 'subtitle')
          ? patch.subtitle
          : currentProfile.subtitle,
      })
      const nextPreferences: DesktopUiPreferences = {
        ...preferences,
        schemaVersion: preferences.schemaVersion,
        sidebar: normalizeSidebarProjectPreferences(preferences.sidebar),
        profile: {
          ...nextProfile,
          avatarFile: currentProfile.avatarFile,
          avatarUpdatedAt: currentProfile.avatarUpdatedAt,
        },
        pet: normalizeDesktopPetPreferences(preferences.pet),
      }

      await this.writePreferences(nextPreferences)
      return nextPreferences
    })
  }

  async updatePetPreferences(pet: unknown): Promise<DesktopUiPreferences> {
    const filePath = this.getPreferencesPath()
    return this.withWriteLock(filePath, async () => {
      const { preferences } = await this.readPreferences()
      const currentPet = normalizeDesktopPetPreferences(preferences.pet)
      const patch = pet && typeof pet === 'object' && !Array.isArray(pet)
        ? pet as Record<string, unknown>
        : {}
      const nextPreferences: DesktopUiPreferences = {
        ...preferences,
        schemaVersion: preferences.schemaVersion,
        sidebar: normalizeSidebarProjectPreferences(preferences.sidebar),
        profile: normalizeProfilePreferences(preferences.profile),
        pet: normalizeDesktopPetPreferences({
          ...currentPet,
          ...patch,
        }),
      }

      await this.writePreferences(nextPreferences)
      return nextPreferences
    })
  }

  async updateProfileAvatar(bytes: Uint8Array, contentType: string | null): Promise<DesktopUiPreferences> {
    const type = contentType?.split(';')[0]?.trim().toLowerCase()
    const avatarType = type ? AVATAR_CONTENT_TYPES[type as keyof typeof AVATAR_CONTENT_TYPES] : undefined
    if (!avatarType) {
      throw ApiError.badRequest('Unsupported avatar type')
    }
    if (bytes.byteLength > MAX_PROFILE_AVATAR_BYTES) {
      throw ApiError.badRequest('Avatar image is too large')
    }

    const filePath = this.getPreferencesPath()
    return this.withWriteLock(filePath, async () => {
      const { preferences } = await this.readPreferences()
      const profileDir = this.getProfileDir()
      const avatarFile = `profile/avatar.${avatarType.extension}`
      const avatarPath = this.getProfileAvatarPath(avatarFile)
      const tmpFile = `${avatarPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`

      await fs.mkdir(profileDir, { recursive: true })
      try {
        await fs.writeFile(tmpFile, bytes)
        await fs.rename(tmpFile, avatarPath)
      } catch (error) {
        await fs.unlink(tmpFile).catch(() => {})
        throw ApiError.internal(`Failed to write profile avatar: ${error}`)
      }

      await Promise.all(
        Object.values(AVATAR_CONTENT_TYPES)
          .filter((candidate) => candidate.extension !== avatarType.extension)
          .map((candidate) => fs.unlink(path.join(profileDir, `avatar.${candidate.extension}`)).catch(() => {})),
      )

      const nextPreferences: DesktopUiPreferences = {
        ...preferences,
        schemaVersion: preferences.schemaVersion,
        sidebar: normalizeSidebarProjectPreferences(preferences.sidebar),
        profile: {
          ...normalizeProfilePreferences(preferences.profile),
          avatarFile,
          avatarUpdatedAt: new Date().toISOString(),
        },
        pet: normalizeDesktopPetPreferences(preferences.pet),
      }

      await this.writePreferences(nextPreferences)
      return nextPreferences
    })
  }

  async clearProfileAvatar(): Promise<DesktopUiPreferences> {
    const filePath = this.getPreferencesPath()
    return this.withWriteLock(filePath, async () => {
      const { preferences } = await this.readPreferences()
      const profileDir = this.getProfileDir()
      await Promise.all(
        Object.values(AVATAR_CONTENT_TYPES)
          .map((candidate) => fs.unlink(path.join(profileDir, `avatar.${candidate.extension}`)).catch(() => {})),
      )
      const nextPreferences: DesktopUiPreferences = {
        ...preferences,
        schemaVersion: preferences.schemaVersion,
        sidebar: normalizeSidebarProjectPreferences(preferences.sidebar),
        profile: {
          ...normalizeProfilePreferences(preferences.profile),
          avatarFile: null,
          avatarUpdatedAt: null,
        },
        pet: normalizeDesktopPetPreferences(preferences.pet),
      }

      await this.writePreferences(nextPreferences)
      return nextPreferences
    })
  }

  async readProfileAvatar(): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const { preferences } = await this.readPreferences()
    const avatarFile = normalizeAvatarFile(preferences.profile.avatarFile)
    if (!avatarFile) return null

    const extension = path.extname(avatarFile).slice(1)
    const contentType = Object.values(AVATAR_CONTENT_TYPES).find((candidate) => candidate.extension === extension)?.mediaType
    if (!contentType) return null

    try {
      return {
        bytes: await fs.readFile(this.getProfileAvatarPath(avatarFile)),
        contentType,
      }
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null
      throw ApiError.internal(`Failed to read profile avatar: ${error}`)
    }
  }
}
