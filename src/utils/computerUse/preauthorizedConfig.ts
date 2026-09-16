import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  getDefaultTierForApp,
  isPolicyDenied,
} from '../../vendor/computer-use-mcp/deniedApps.js'
import type {
  AppGrant,
  CuGrantFlags,
} from '../../vendor/computer-use-mcp/types.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'

export type StoredAuthorizedApp = {
  bundleId: string
  displayName: string
  authorizedAt?: string
  [key: string]: unknown
}

export type StoredComputerUseConfig = {
  enabled?: boolean
  authorizedApps?: StoredAuthorizedApp[]
  grantFlags?: Partial<CuGrantFlags>
  pythonPath?: string | null
  [key: string]: unknown
}

// Computer Use starts off so the first enablement always crosses the explicit
// risk-confirmation boundary in the desktop settings page.
export const DEFAULT_COMPUTER_USE_ENABLED = false

export const DEFAULT_DESKTOP_GRANT_FLAGS: CuGrantFlags = {
  clipboardRead: true,
  clipboardWrite: true,
  systemKeyCombos: true,
}

const FAIL_CLOSED_GRANT_FLAGS: CuGrantFlags = {
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
}

export function getComputerUseConfigPath(): string {
  return join(
    getClaudeConfigHomeDir(),
    'cc-haha',
    'computer-use-config.json',
  )
}

export function resolveStoredComputerUseConfig(
  config?: StoredComputerUseConfig,
): {
  enabled: boolean
  authorizedApps: StoredAuthorizedApp[]
  grantFlags: CuGrantFlags
  pythonPath: string | null
} {
  return {
    enabled: config?.enabled ?? DEFAULT_COMPUTER_USE_ENABLED,
    authorizedApps: config?.authorizedApps ?? [],
    grantFlags: {
      ...DEFAULT_DESKTOP_GRANT_FLAGS,
      ...(config?.grantFlags ?? {}),
    },
    pythonPath: normalizePythonPath(config?.pythonPath),
  }
}

export function normalizePythonPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStoredAuthorizedApp(value: unknown): value is StoredAuthorizedApp {
  if (!isPlainObject(value)) return false
  if (typeof value.bundleId !== 'string' || !value.bundleId.trim()) return false
  if (typeof value.displayName !== 'string' || !value.displayName.trim()) return false
  return value.authorizedAt === undefined || typeof value.authorizedAt === 'string'
}

export function parseStoredComputerUseConfig(
  value: unknown,
): StoredComputerUseConfig | null {
  if (!isPlainObject(value)) return null
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return null
  if (
    value.authorizedApps !== undefined
    && (
      !Array.isArray(value.authorizedApps)
      || !value.authorizedApps.every(isStoredAuthorizedApp)
    )
  ) {
    return null
  }
  if (value.grantFlags !== undefined) {
    if (!isPlainObject(value.grantFlags)) return null
    for (const flag of ['clipboardRead', 'clipboardWrite', 'systemKeyCombos'] as const) {
      if (value.grantFlags[flag] !== undefined && typeof value.grantFlags[flag] !== 'boolean') {
        return null
      }
    }
  }
  if (
    value.pythonPath !== undefined
    && value.pythonPath !== null
    && typeof value.pythonPath !== 'string'
  ) {
    return null
  }

  return {
    ...value,
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.authorizedApps === undefined
      ? {}
      : {
          authorizedApps: value.authorizedApps.map(app => ({
            ...app,
            bundleId: app.bundleId.trim(),
            displayName: app.displayName.trim(),
          })),
        }),
    ...(value.grantFlags === undefined
      ? {}
      : {
          grantFlags: {
            ...value.grantFlags,
            ...(value.grantFlags.clipboardRead === undefined
              ? {}
              : { clipboardRead: value.grantFlags.clipboardRead }),
            ...(value.grantFlags.clipboardWrite === undefined
              ? {}
              : { clipboardWrite: value.grantFlags.clipboardWrite }),
            ...(value.grantFlags.systemKeyCombos === undefined
              ? {}
              : { systemKeyCombos: value.grantFlags.systemKeyCombos }),
          },
        }),
    ...(value.pythonPath === undefined ? {} : { pythonPath: value.pythonPath }),
  }
}

export function buildPreAuthorizedAppGrants(
  apps: StoredAuthorizedApp[],
  grantedAt = Date.now(),
): AppGrant[] {
  return apps
    .filter(app => !isPolicyDenied(app.bundleId, app.displayName))
    .map(app => ({
      bundleId: app.bundleId,
      displayName: app.displayName,
      grantedAt,
      tier: getDefaultTierForApp(app.bundleId, app.displayName),
    }))
}

export type StoredComputerUseConfigLoadResult = {
  config: ReturnType<typeof resolveStoredComputerUseConfig>
  error: string | null
}

export async function loadStoredComputerUseConfigResult(): Promise<
  StoredComputerUseConfigLoadResult
> {
  try {
    const raw = await readFile(getComputerUseConfigPath(), 'utf8')
    const parsed = parseStoredComputerUseConfig(JSON.parse(raw))
    if (!parsed) {
      return {
        config: resolveStoredComputerUseConfig({
          enabled: false,
          authorizedApps: [],
          grantFlags: FAIL_CLOSED_GRANT_FLAGS,
        }),
        error: 'Computer Use config is invalid',
      }
    }
    return { config: resolveStoredComputerUseConfig(parsed), error: null }
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return { config: resolveStoredComputerUseConfig(), error: null }
    }
    return {
      config: resolveStoredComputerUseConfig({
        enabled: false,
        authorizedApps: [],
        grantFlags: FAIL_CLOSED_GRANT_FLAGS,
      }),
      error: error instanceof Error ? error.message : 'Computer Use config could not be read',
    }
  }
}

export async function loadStoredComputerUseConfig(): Promise<
  ReturnType<typeof resolveStoredComputerUseConfig>
> {
  return (await loadStoredComputerUseConfigResult()).config
}

export async function saveStoredComputerUseConfig(
  config: StoredComputerUseConfig,
): Promise<void> {
  const configPath = getComputerUseConfigPath()
  const tempPath = `${configPath}.${randomUUID()}.tmp`
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  try {
    let existing: StoredComputerUseConfig = {}
    try {
      const parsed = parseStoredComputerUseConfig(
        JSON.parse(await readFile(configPath, 'utf8')),
      )
      if (!parsed) throw new Error('Computer Use config is invalid')
      existing = parsed
    } catch (error) {
      if (
        !error
        || typeof error !== 'object'
        || !('code' in error)
        || error.code !== 'ENOENT'
      ) {
        throw error
      }
    }
    const merged = {
      ...existing,
      ...config,
      grantFlags: {
        ...(isPlainObject(existing.grantFlags) ? existing.grantFlags : {}),
        ...(config.grantFlags ?? {}),
      },
    }
    await writeFile(tempPath, JSON.stringify(merged, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(tempPath, configPath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}
