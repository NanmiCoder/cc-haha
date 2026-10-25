import { getProviderRuntimeContext, getProviderRuntimeEnvironment } from '../api/providerRuntimeContext.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import memoize from 'lodash-es/memoize.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import type { OpenAIOAuthTokens } from './types.js'

const STORAGE_KEY = 'openaiCodexOauth'
export const OPENAI_CODEX_OAUTH_FILE_ENV_KEY = 'OPENAI_CODEX_OAUTH_FILE'

type SecureStorageShape = Record<string, unknown> & {
  openaiCodexOauth?: OpenAIOAuthTokens
}

const SECURE_STORAGE_CACHE_KEY = 'secure-storage'
const FILE_CACHE_KEY_PREFIX = 'file:'
const FILE_BACKED_STORAGE_MARKER_FILE = 'openai-oauth-file-backed'

function getDesktopTokenFilePath(): string | null {
  const filePath = getProviderRuntimeEnvironment()[OPENAI_CODEX_OAUTH_FILE_ENV_KEY]?.trim()
  return filePath ? filePath : null
}

function getCcHahaDir(): string {
  const configDir =
    getProviderRuntimeEnvironment().CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'cc-haha')
}

function getFileBackedStorageMarkerPath(): string {
  return path.join(getCcHahaDir(), FILE_BACKED_STORAGE_MARKER_FILE)
}

function markFileBackedStorageUsed(): void {
  try {
    fs.mkdirSync(getCcHahaDir(), { recursive: true })
    fs.writeFileSync(getFileBackedStorageMarkerPath(), '1\n', { mode: 0o600 })
  } catch (error) {
    logError(error)
  }
}

function clearFileBackedStorageMarker(): void {
  try {
    fs.rmSync(getFileBackedStorageMarkerPath(), { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(error)
    }
  }
}

function isSecureStorageFallbackDisabled(): boolean {
  return fs.existsSync(getFileBackedStorageMarkerPath())
}

function normalizeTokenFile(value: unknown): OpenAIOAuthTokens | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  if (
    typeof record.accessToken !== 'string' ||
    typeof record.refreshToken !== 'string' ||
    typeof record.expiresAt !== 'number'
  ) {
    return null
  }

  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    ...(typeof record.idToken === 'string' && { idToken: record.idToken }),
    ...(typeof record.accountId === 'string' && {
      accountId: record.accountId,
    }),
    ...(typeof record.email === 'string' && { email: record.email }),
    ...(typeof record.clientId === 'string' && { clientId: record.clientId }),
  }
}

function readDesktopTokenFileSync(filePath = getDesktopTokenFilePath()): OpenAIOAuthTokens | null {
  if (!filePath) return null

  try {
    return normalizeTokenFile(JSON.parse(fs.readFileSync(filePath, 'utf-8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(error)
    }
    return null
  }
}

async function readDesktopTokenFileAsync(
  filePath = getDesktopTokenFilePath(),
): Promise<OpenAIOAuthTokens | null> {
  if (!filePath) return null

  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8')
    return normalizeTokenFile(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(error)
    }
    return null
  }
}

function writeDesktopTokenFileSync(tokens: OpenAIOAuthTokens): boolean {
  const filePath = getDesktopTokenFilePath()
  if (!filePath) return false

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}`
  let renamed = false

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(tokens, null, 2) + '\n', {
      mode: 0o600,
    })
    fs.renameSync(tmpFile, filePath)
    renamed = true
    return true
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(tmpFile, { force: true })
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          logError(cleanupError)
        }
      }
    }
  }
}

export function saveOpenAIOAuthTokens(tokens: OpenAIOAuthTokens): {
  success: boolean
  warning?: string
} {
  if (getProviderRuntimeContext() && !getDesktopTokenFilePath()) {
    return { success: false, warning: 'Explicit OpenAI provider has no token file' }
  }
  try {
    if (writeDesktopTokenFileSync(tokens)) {
      markFileBackedStorageUsed()
      clearOpenAIOAuthTokenCache()
      return { success: true }
    }

    const storage = getSecureStorage()
    const data = (storage.read() ?? {}) as SecureStorageShape
    data[STORAGE_KEY] = tokens
    const result = storage.update(data)
    if (result.success) {
      clearFileBackedStorageMarker()
    }
    clearOpenAIOAuthTokenCache()
    return result
  } catch (error) {
    logError(error)
    return {
      success: false,
      warning: `Failed to save OpenAI OAuth tokens: ${errorMessage(error)}`,
    }
  }
}

const getOpenAIOAuthTokensCached = memoize(
  (cacheKey: string): OpenAIOAuthTokens | null => {
    if (cacheKey.startsWith(FILE_CACHE_KEY_PREFIX)) {
      return readDesktopTokenFileSync(
        cacheKey.slice(FILE_CACHE_KEY_PREFIX.length),
      )
    }

    if (isSecureStorageFallbackDisabled()) {
      return null
    }

    try {
      const storage = getSecureStorage()
      const data = storage.read() as SecureStorageShape | null
      return data?.openaiCodexOauth ?? null
    } catch (error) {
      logError(error)
      return null
    }
  },
)

export function getOpenAIOAuthTokens(): OpenAIOAuthTokens | null {
  const filePath = getDesktopTokenFilePath()
  if (getProviderRuntimeContext() && !filePath) return null
  return getOpenAIOAuthTokensCached(
    filePath ? `${FILE_CACHE_KEY_PREFIX}${filePath}` : SECURE_STORAGE_CACHE_KEY,
  )
}

export async function getOpenAIOAuthTokensAsync(): Promise<OpenAIOAuthTokens | null> {
  const filePath = getDesktopTokenFilePath()
  if (getProviderRuntimeContext() && !filePath) return null
  if (filePath) {
    return readDesktopTokenFileAsync(filePath)
  }

  if (isSecureStorageFallbackDisabled()) {
    return null
  }

  try {
    const storage = getSecureStorage()
    const data = (await storage.readAsync()) as SecureStorageShape | null
    return data?.openaiCodexOauth ?? null
  } catch (error) {
    logError(error)
    return null
  }
}

export function clearOpenAIOAuthTokenCache(): void {
  getOpenAIOAuthTokensCached.cache?.clear?.()
}

export function deleteOpenAIOAuthTokens(): boolean {
  try {
    const filePath = getDesktopTokenFilePath()
    if (filePath) {
      fs.rmSync(filePath, { force: true })
      markFileBackedStorageUsed()
      clearOpenAIOAuthTokenCache()
      return true
    }

    const storage = getSecureStorage()
    const data = (storage.read() ?? {}) as SecureStorageShape
    delete data[STORAGE_KEY]
    const result = storage.update(data)
    clearOpenAIOAuthTokenCache()
    return result.success
  } catch (error) {
    logError(error)
    return false
  }
}
