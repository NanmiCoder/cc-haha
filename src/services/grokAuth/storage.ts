import * as fs from 'fs'
import * as path from 'path'
import type { GrokOAuthTokens } from './types.js'

export const GROK_OAUTH_FILE_ENV_KEY = 'GROK_OAUTH_FILE'

export function getGrokOAuthTokenFilePath(): string | null {
  return process.env[GROK_OAUTH_FILE_ENV_KEY]?.trim() || null
}

export function getGrokOAuthTokens(): GrokOAuthTokens | null {
  const filePath = getGrokOAuthTokenFilePath()
  if (!filePath) return null
  try {
    return normalizeTokenFile(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return null
  }
}

export async function getGrokOAuthTokensAsync(): Promise<GrokOAuthTokens | null> {
  const filePath = getGrokOAuthTokenFilePath()
  if (!filePath) return null
  try {
    return normalizeTokenFile(
      JSON.parse(await fs.promises.readFile(filePath, 'utf8')),
    )
  } catch {
    return null
  }
}

export function saveGrokOAuthTokens(tokens: GrokOAuthTokens): boolean {
  const filePath = getGrokOAuthTokenFilePath()
  if (!filePath) return false
  const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  let renamed = false
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, {
      mode: 0o600,
    })
    fs.renameSync(temporaryPath, filePath)
    renamed = true
    return true
  } catch {
    return false
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(temporaryPath, { force: true })
      } catch {
        // Best-effort cleanup; never expose token contents in an error.
      }
    }
  }
}

function normalizeTokenFile(value: unknown): GrokOAuthTokens | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const accessToken = stringField(record, 'accessToken', 'access_token')
  const refreshToken = stringField(record, 'refreshToken', 'refresh_token')
  const expiresAt = expiryField(record.expiresAt ?? record.expires_at)
  if (!accessToken || !refreshToken || expiresAt === null) return null
  return {
    accessToken,
    refreshToken,
    expiresAt,
    ...optionalString(record, 'idToken', 'id_token'),
    ...optionalString(record, 'email'),
    ...optionalString(record, 'clientId', 'client_id'),
    ...optionalString(record, 'scope'),
    ...optionalString(record, 'tokenType', 'token_type'),
  }
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key].trim()) {
      return record[key].trim()
    }
  }
  return undefined
}

function optionalString(
  record: Record<string, unknown>,
  target: keyof GrokOAuthTokens,
  source = target,
): Partial<GrokOAuthTokens> {
  const value = stringField(record, target, source)
  return value ? { [target]: value } : {}
}

function expiryField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}
