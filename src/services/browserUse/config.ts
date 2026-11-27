import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BROWSER_USE_PREFERRED_TARGETS,
  type BrowserPreferredTarget,
  type BrowserUseConfig,
} from './types'

const CONFIG_FILENAME = 'browser-use-config.json'
const CONFIG_TTL_MS = 1_500

export const DEFAULT_BROWSER_USE_CONFIG: BrowserUseConfig = {
  enabled: false,
  preferredTarget: 'auto',
  showCursorOverlay: true,
  autoOpenWorkspacePanel: true,
  managedChromeHeadless: false,
}

interface CachedConfigEntry {
  path: string
  config: BrowserUseConfig
  expiresAt: number
}

let cachedEntry: CachedConfigEntry | null = null

export function resolveClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.CLAUDE_CONFIG_DIR?.trim()
  if (explicit) {
    return explicit.normalize('NFC')
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  return join(home, '.claude').normalize('NFC')
}

export function getBrowserUseConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveClaudeConfigDir(env), 'cc-haha', CONFIG_FILENAME)
}

export function getManagedChromeProfileDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    resolveClaudeConfigDir(env),
    'browser-profiles',
    'managed-chrome',
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePreferredTarget(value: unknown): BrowserPreferredTarget {
  if (
    typeof value === 'string' &&
    (BROWSER_USE_PREFERRED_TARGETS as readonly string[]).includes(value)
  ) {
    return value as BrowserPreferredTarget
  }
  return DEFAULT_BROWSER_USE_CONFIG.preferredTarget
}

function normalizeBlockedPorts(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const ports: number[] = []
  for (const item of value) {
    if (
      typeof item === 'number' &&
      Number.isInteger(item) &&
      item > 0 &&
      item <= 65535
    ) {
      ports.push(item)
    }
  }
  return ports
}

function parseConfigObject(raw: Record<string, unknown>): BrowserUseConfig {
  const blockedLoopbackPorts = normalizeBlockedPorts(raw.blockedLoopbackPorts)
  const chromeBinaryPath =
    typeof raw.chromeBinaryPath === 'string' && raw.chromeBinaryPath.trim()
      ? raw.chromeBinaryPath.trim()
      : undefined
  const chromeUserDataDir =
    typeof raw.chromeUserDataDir === 'string' && raw.chromeUserDataDir.trim()
      ? raw.chromeUserDataDir.trim()
      : undefined
  const consentAcceptedAt =
    typeof raw.consentAcceptedAt === 'string' && raw.consentAcceptedAt.trim()
      ? raw.consentAcceptedAt.trim()
      : undefined
  const updatedAt =
    typeof raw.updatedAt === 'string' && raw.updatedAt.trim()
      ? raw.updatedAt.trim()
      : undefined

  return {
    enabled: raw.enabled === true,
    preferredTarget: normalizePreferredTarget(raw.preferredTarget),
    showCursorOverlay:
      typeof raw.showCursorOverlay === 'boolean'
        ? raw.showCursorOverlay
        : DEFAULT_BROWSER_USE_CONFIG.showCursorOverlay,
    autoOpenWorkspacePanel:
      typeof raw.autoOpenWorkspacePanel === 'boolean'
        ? raw.autoOpenWorkspacePanel
        : DEFAULT_BROWSER_USE_CONFIG.autoOpenWorkspacePanel,
    managedChromeHeadless:
      typeof raw.managedChromeHeadless === 'boolean'
        ? raw.managedChromeHeadless
        : DEFAULT_BROWSER_USE_CONFIG.managedChromeHeadless,
    ...(blockedLoopbackPorts !== undefined ? { blockedLoopbackPorts } : {}),
    ...(chromeBinaryPath ? { chromeBinaryPath } : {}),
    ...(chromeUserDataDir ? { chromeUserDataDir } : {}),
    ...(consentAcceptedAt ? { consentAcceptedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function readRawConfigFile(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) {
    return null
  }
  const content = readFileSync(configPath, 'utf8')
  const parsed: unknown = JSON.parse(content)
  if (!isPlainObject(parsed)) {
    throw new Error('Browser Use config must be a JSON object')
  }
  return parsed
}

export function invalidateBrowserUseConfigCache(): void {
  cachedEntry = null
}

/**
 * Loads Browser Use configuration from `~/.claude/cc-haha/browser-use-config.json`.
 * Fail-closed: if the file is missing, unreadable, or malformed JSON, returns
 * `enabled: false` with safe defaults.
 */
export function loadBrowserUseConfig(
  options: { env?: NodeJS.ProcessEnv; bypassCache?: boolean } = {},
): BrowserUseConfig {
  const configPath = getBrowserUseConfigPath(options.env)
  const now = Date.now()
  if (
    !options.bypassCache &&
    cachedEntry &&
    cachedEntry.path === configPath &&
    cachedEntry.expiresAt > now
  ) {
    return { ...cachedEntry.config }
  }

  let config: BrowserUseConfig
  try {
    const raw = readRawConfigFile(configPath)
    config = raw ? parseConfigObject(raw) : { ...DEFAULT_BROWSER_USE_CONFIG }
  } catch {
    config = { ...DEFAULT_BROWSER_USE_CONFIG, enabled: false }
  }

  cachedEntry = {
    path: configPath,
    config: { ...config },
    expiresAt: now + CONFIG_TTL_MS,
  }
  return { ...config }
}

/**
 * Atomically saves Browser Use configuration using a sibling temp file,
 * `0o600` permissions, and rename. Preserves unknown top-level keys already
 * stored in the config file.
 */
export function saveBrowserUseConfig(
  patch: Partial<BrowserUseConfig>,
  options: { env?: NodeJS.ProcessEnv } = {},
): BrowserUseConfig {
  const configPath = getBrowserUseConfigPath(options.env)
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })

  let existingRaw: Record<string, unknown> = {}
  try {
    const raw = readRawConfigFile(configPath)
    if (raw) {
      existingRaw = { ...raw }
    }
  } catch {
    existingRaw = {}
  }

  const currentConfig = parseConfigObject(existingRaw)
  const mergedConfig: BrowserUseConfig = {
    ...currentConfig,
    ...patch,
    enabled:
      typeof patch.enabled === 'boolean' ? patch.enabled : currentConfig.enabled,
    preferredTarget:
      patch.preferredTarget !== undefined
        ? normalizePreferredTarget(patch.preferredTarget)
        : currentConfig.preferredTarget,
    showCursorOverlay:
      typeof patch.showCursorOverlay === 'boolean'
        ? patch.showCursorOverlay
        : currentConfig.showCursorOverlay,
    autoOpenWorkspacePanel:
      typeof patch.autoOpenWorkspacePanel === 'boolean'
        ? patch.autoOpenWorkspacePanel
        : currentConfig.autoOpenWorkspacePanel,
    managedChromeHeadless:
      typeof patch.managedChromeHeadless === 'boolean'
        ? patch.managedChromeHeadless
        : currentConfig.managedChromeHeadless,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  }

  const mergedDisk: Record<string, unknown> = {
    ...existingRaw,
    enabled: mergedConfig.enabled,
    preferredTarget: mergedConfig.preferredTarget,
    showCursorOverlay: mergedConfig.showCursorOverlay,
    autoOpenWorkspacePanel: mergedConfig.autoOpenWorkspacePanel,
    managedChromeHeadless: mergedConfig.managedChromeHeadless,
    updatedAt: mergedConfig.updatedAt,
  }

  const optionalKeys = [
    'blockedLoopbackPorts',
    'chromeBinaryPath',
    'chromeUserDataDir',
    'consentAcceptedAt',
  ] as const

  for (const key of optionalKeys) {
    if (key in patch) {
      const value = patch[key]
      if (value === undefined || value === '') {
        delete mergedDisk[key]
        delete mergedConfig[key]
      } else {
        mergedDisk[key] = value
      }
    }
  }

  const serialized = `${JSON.stringify(mergedDisk, null, 2)}\n`
  const tempPath = join(
    dir,
    `.${CONFIG_FILENAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )

  try {
    writeFileSync(tempPath, serialized, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(tempPath, 0o600)
    } catch {
      // Best-effort on platforms where chmod is restricted
    }
    renameSync(tempPath, configPath)
  } catch (err) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath)
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err
  }

  cachedEntry = {
    path: configPath,
    config: { ...mergedConfig },
    expiresAt: Date.now() + CONFIG_TTL_MS,
  }
  return { ...mergedConfig }
}

export function isBrowserUseEnabled(
  options: { env?: NodeJS.ProcessEnv; bypassCache?: boolean } = {},
): boolean {
  return loadBrowserUseConfig(options).enabled === true
}
