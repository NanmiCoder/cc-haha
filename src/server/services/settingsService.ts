/**
 * Settings Service — read/write user-level and project-level settings files
 *
 * Settings files are JSON:
 *   - User level: ~/.claude/settings.json
 *   - Project level: {projectRoot}/.claude/settings.json
 *
 * Merge strategy: Object.assign({}, userSettings, projectSettings)
 */

import * as fs from 'fs/promises'
import { randomBytes } from 'node:crypto'
import * as path from 'path'
import * as os from 'os'
import { ApiError } from '../middleware/errorHandler.js'
import { normalizeJsonObject, readRecoverableJsonFile } from './recoverableJsonFile.js'
import { ensurePersistentStorageUpgraded } from './persistentStorageMigrations.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { addFileGlobRuleToGitignore } from '../../utils/git/gitignore.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getProcessEnvWithTerminalShellEnvironment } from '../../utils/terminalShellEnvironment.js'
import type { ModelMapping } from '../types/provider.js'

export const VALID_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
] as const

export type PermissionMode = (typeof VALID_PERMISSION_MODES)[number]

export function isValidPermissionMode(mode: unknown): mode is PermissionMode {
  return typeof mode === 'string' && VALID_PERMISSION_MODES.includes(mode as PermissionMode)
}

export class SettingsService {
  private static writeLocks = new Map<string, Promise<void>>()
  private projectRoot?: string

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot
  }

  /** Config directory; can be overridden via environment variable (for tests) */
  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  /** User-level settings file path */
  private getUserSettingsPath(): string {
    return path.join(this.getConfigDir(), 'settings.json')
  }

  /** Project-level settings file path */
  private getProjectSettingsPath(projectRoot?: string): string {
    const root = projectRoot || this.projectRoot
    if (!root) {
      throw ApiError.badRequest('Project root is required for project settings')
    }
    return path.join(root, '.claude', 'settings.json')
  }

  /** Project-local settings file path (not recommended to commit) */
  private getLocalSettingsPath(projectRoot?: string): string {
    const root = projectRoot || this.projectRoot
    if (!root) {
      throw ApiError.badRequest('Project root is required for local settings')
    }
    return path.join(root, '.claude', 'settings.local.json')
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /** Safely read a JSON file; returns an empty object when the file does not exist */
  private async readJsonFile(filePath: string): Promise<Record<string, unknown>> {
    await ensurePersistentStorageUpgraded()
    return readRecoverableJsonFile({
      filePath,
      label: 'settings',
      defaultValue: {},
      normalize: normalizeJsonObject,
    })
  }

  /** Get merged settings (user + project) */
  async getSettings(projectRoot?: string): Promise<Record<string, unknown>> {
    const user = await this.getUserSettings()
    try {
      const project = await this.getProjectSettings(projectRoot)
      return Object.assign({}, user, project)
    } catch {
      // When project root is not specified, return only user settings
      return user
    }
  }

  /** Get user-level settings */
  async getUserSettings(): Promise<Record<string, unknown>> {
    return this.readJsonFile(this.getUserSettingsPath())
  }

  /** Read-time upgrade for settings written before the desktop update toggle.
   * Do not rewrite the user-owned file until an explicit preference is saved.
   */
  async getAutoUpdateEnabled(settings?: Record<string, unknown>): Promise<boolean> {
    const user = settings ?? await this.getUserSettings()
    return user.autoUpdateEnabled !== false
  }

  /** Forward read migration: the desktop experiment is opt-in for legacy files. */
  async getLeanModeEnabled(settings?: Record<string, unknown>): Promise<boolean> {
    const user = settings ?? await this.getUserSettings()
    return user.leanModeEnabled === true
  }

  /** Older settings without a concurrency limit are read as unlimited; the user file is not rewritten automatically. */
  async getMaxConcurrentSubagents(settings?: Record<string, unknown>): Promise<number | null> {
    const user = settings ?? await this.getUserSettings()
    const value = user.maxConcurrentSubagents
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
  }

  /** Desktop composer next-prompt suggestions; opt-in because each turn costs an extra request. */
  async getNextPromptSuggestionsEnabled(): Promise<boolean> {
    return (await this.getUserSettings()).nextPromptSuggestionsEnabled === true
  }

  /** Read-time upgrade for older settings that only stored the team env flag.
   * Keep the original file intact until the user explicitly saves a choice.
   */
  async getAgentTeamsEnabled(): Promise<boolean> {
    const user = await this.getUserSettings()
    if (typeof user.agentTeamsEnabled === 'boolean') return user.agentTeamsEnabled
    const managed = await this.readJsonFile(path.join(this.getConfigDir(), 'cc-haha', 'settings.json'))
    const inherited = await getProcessEnvWithTerminalShellEnvironment()
    const key = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'
    const legacyValue = normalizeJsonObject(managed.env)?.[key] ??
      normalizeJsonObject(user.env)?.[key] ?? inherited[key]
    return typeof legacyValue === 'string' ? isEnvTruthy(legacyValue) : true
  }

  /** Get project-level settings */
  async getProjectSettings(projectRoot?: string): Promise<Record<string, unknown>> {
    return this.readJsonFile(this.getProjectSettingsPath(projectRoot))
  }

  /** Get project-local settings */
  async getLocalSettings(projectRoot?: string): Promise<Record<string, unknown>> {
    return this.readJsonFile(this.getLocalSettingsPath(projectRoot))
  }

  // ---------------------------------------------------------------------------
  // Write (atomic: write a temp file, then rename)
  // ---------------------------------------------------------------------------

  /** Atomically write a JSON file */
  private async withWriteLock<T>(
    filePath: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previousWrite = SettingsService.writeLocks.get(filePath) ?? Promise.resolve()
    const nextWrite = previousWrite
      .catch(() => {})
      .then(task)

    SettingsService.writeLocks.set(filePath, nextWrite)

    try {
      return await nextWrite
    } finally {
      if (SettingsService.writeLocks.get(filePath) === nextWrite) {
        SettingsService.writeLocks.delete(filePath)
      }
    }
  }

  private async writeJsonFile(
    filePath: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const dir = path.dirname(filePath)
    const contents = JSON.stringify(data, null, 2) + '\n'
    let lastError: unknown

    for (let attempt = 0; attempt < 2; attempt++) {
      const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`
      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(tmpFile, contents, 'utf-8')
        await fs.rename(tmpFile, filePath)
        resetSettingsCache()
        return
      } catch (err) {
        lastError = err
        await fs.unlink(tmpFile).catch(() => {})

        if (
          (err as NodeJS.ErrnoException).code !== 'ENOENT' ||
          attempt === 1
        ) {
          break
        }
      }
    }

    throw ApiError.internal(
      `Failed to write settings to ${filePath}: ${lastError}`,
    )
  }

  /** Update user-level settings (top-level shallow merge, preserving unknown subfields from the desktop terminal) */
  async updateUserSettings(settings: Record<string, unknown>): Promise<void> {
    if (Object.hasOwn(settings, 'leanModeEnabled') && typeof settings.leanModeEnabled !== 'boolean') {
      throw ApiError.badRequest('leanModeEnabled must be a boolean')
    }
    if (Object.hasOwn(settings, 'autoUpdateEnabled') && typeof settings.autoUpdateEnabled !== 'boolean') {
      throw ApiError.badRequest('autoUpdateEnabled must be a boolean')
    }
    if (Object.hasOwn(settings, 'agentTeamsEnabled') && typeof settings.agentTeamsEnabled !== 'boolean') {
      throw ApiError.badRequest('agentTeamsEnabled must be a boolean')
    }
    if (Object.hasOwn(settings, 'maxConcurrentSubagents')) {
      const value = settings.maxConcurrentSubagents
      if (value !== null && !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) {
        throw ApiError.badRequest('maxConcurrentSubagents must be null or a positive safe integer')
      }
    }
    const filePath = this.getUserSettingsPath()
    await this.withWriteLock(filePath, async () => {
      const current = await this.readJsonFile(filePath)
      const merged = Object.assign({}, current, settings)
      const currentDesktopTerminal = normalizeJsonObject(current.desktopTerminal)
      const updatedDesktopTerminal = normalizeJsonObject(settings.desktopTerminal)
      if (currentDesktopTerminal && updatedDesktopTerminal) {
        merged.desktopTerminal = Object.assign(
          {},
          currentDesktopTerminal,
          updatedDesktopTerminal,
        )
      }
      await this.writeJsonFile(filePath, merged)
    })
  }

  /**
   * Persist the model aliases owned by the built-in Claude OAuth provider while
   * preserving unrelated user env keys. The provider picker writes all aliases
   * as one locked update so two settings actions cannot lose each other's env.
   */
  async updateOfficialModelMapping(models: ModelMapping): Promise<void> {
    const filePath = this.getUserSettingsPath()
    await this.withWriteLock(filePath, async () => {
      const current = await this.readJsonFile(filePath)
      const env = {
        ...(normalizeJsonObject(current.env) as Record<string, string> | undefined),
        ANTHROPIC_MODEL: models.main,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
        ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
        ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
      }
      if (models.fable) {
        env.ANTHROPIC_DEFAULT_FABLE_MODEL = models.fable
      } else {
        delete env.ANTHROPIC_DEFAULT_FABLE_MODEL
      }

      const next = {
        ...current,
        model: models.main,
        env,
      }
      delete next.modelContext
      await this.writeJsonFile(filePath, next)
    })
  }

  /** Update project-level settings (shallow merge) */
  async updateProjectSettings(
    settings: Record<string, unknown>,
    projectRoot?: string,
  ): Promise<void> {
    const filePath = this.getProjectSettingsPath(projectRoot)
    await this.withWriteLock(filePath, async () => {
      const current = await this.readJsonFile(filePath)
      const merged = Object.assign({}, current, settings)
      await this.writeJsonFile(filePath, merged)
    })
  }

  /** Update project-local settings (shallow merge) */
  async updateLocalSettings(
    settings: Record<string, unknown>,
    projectRoot?: string,
  ): Promise<void> {
    const root = projectRoot || this.projectRoot
    const filePath = this.getLocalSettingsPath(projectRoot)
    await this.withWriteLock(filePath, async () => {
      const current = await this.readJsonFile(filePath)
      const merged = Object.assign({}, current, settings)
      await this.writeJsonFile(filePath, merged)
    })
    if (root) {
      void addFileGlobRuleToGitignore('.claude/settings.local.json', root)
    }
  }

  /**
   * Merge the model/provider/effort override for a single built-in Agent.
   *
   * When `patch` is null, delete model/provider/effort; when a field value is null, delete only that field.
   * An emptied entry is deleted along with it, and the `builtInAgentOverrides` key is removed when it becomes empty,
   * so no empty shell is left in the user's settings.json.
   *
   * Does not use updateUserSettings: that is a top-level shallow merge, so passing builtInAgentOverrides would
   * replace the whole record. If the caller read first and computed a diff, the read-modify-write would fall outside the write lock, and clicking two
   * Agents in a row would lose one update.
   */
  async updateBuiltInAgentOverride(
    agentType: string,
    patch: {
      model?: string | null
      provider?: string | null
      effort?: string | number | null
    } | null,
  ): Promise<void> {
    const filePath = this.getUserSettingsPath()
    await this.withWriteLock(filePath, async () => {
      const current = await this.readJsonFile(filePath)
      const overrides = { ...(normalizeJsonObject(current.builtInAgentOverrides) ?? {}) }

      const entry = { ...(normalizeJsonObject(overrides[agentType]) ?? {}) }
      if (patch === null) {
        // Clear only the fields this API owns. The schema deliberately allows
        // future per-agent fields, so reset must not erase data written by a
        // newer client or another settings editor.
        delete entry.model
        delete entry.provider
        delete entry.effort
      } else {
        for (const field of ['model', 'provider', 'effort'] as const) {
          if (!Object.hasOwn(patch, field)) continue
          if (patch[field] === null) {
            delete entry[field]
          } else {
            entry[field] = patch[field]
          }
        }
      }
      if (Object.keys(entry).length === 0) {
        delete overrides[agentType]
      } else {
        overrides[agentType] = entry
      }

      const merged = Object.assign({}, current)
      if (Object.keys(overrides).length === 0) {
        delete merged.builtInAgentOverrides
      } else {
        merged.builtInAgentOverrides = overrides
      }
      await this.writeJsonFile(filePath, merged)
    })
  }

  // ---------------------------------------------------------------------------
  // Permission mode
  // ---------------------------------------------------------------------------

  /** Get the current permission mode */
  async getPermissionMode(): Promise<string> {
    const settings = await this.getUserSettings()
    const mode = settings.defaultMode
    return isValidPermissionMode(mode)
      ? mode
      : 'default'
  }

  /** Set the permission mode */
  async setPermissionMode(mode: string): Promise<void> {
    if (!isValidPermissionMode(mode)) {
      throw ApiError.badRequest(
        `Invalid permission mode: "${mode}". Valid modes: ${VALID_PERMISSION_MODES.join(', ')}`,
      )
    }
    await this.updateUserSettings({ defaultMode: mode })
  }
}
