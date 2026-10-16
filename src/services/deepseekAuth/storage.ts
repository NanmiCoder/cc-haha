import * as fs from 'fs'
import * as path from 'path'
import {
  DEEPSEEK_PLATFORM_ORIGIN,
  getDeepSeekPlatformOrigin,
} from './client.js'
import type { DeepSeekOAuthTokens } from './types.js'

export const DEEPSEEK_OAUTH_FILE_ENV_KEY = 'DEEPSEEK_OAUTH_FILE'

export function getDeepSeekOAuthTokenFilePath(): string | null {
  return process.env[DEEPSEEK_OAUTH_FILE_ENV_KEY]?.trim() || null
}

/**
 * Read the grant the desktop server stored. Returns null for a missing,
 * malformed, or foreign-issuer file: a grant minted by another platform
 * origin (a development mock, for example) must never reach the production
 * inference endpoint.
 */
export function getDeepSeekOAuthTokens(): DeepSeekOAuthTokens | null {
  const filePath = getDeepSeekOAuthTokenFilePath()
  if (!filePath) return null
  try {
    return normalizeTokenFile(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return null
  }
}

/**
 * The inference origin is fixed to production, so only a grant the production
 * platform issued may be sent there. A loopback or staging override of the
 * platform origin (and DSH's own `dsh_mock_` development tokens) can sign in
 * for testing but never authenticates a model request.
 */
export function isInferenceEligibleGrant(tokens: DeepSeekOAuthTokens): boolean {
  return (
    tokens.issuer === DEEPSEEK_PLATFORM_ORIGIN &&
    !tokens.token.startsWith('dsh_mock_')
  )
}

export async function getDeepSeekOAuthTokensAsync(): Promise<DeepSeekOAuthTokens | null> {
  const filePath = getDeepSeekOAuthTokenFilePath()
  if (!filePath) return null
  try {
    return normalizeTokenFile(
      JSON.parse(await fs.promises.readFile(filePath, 'utf8')),
    )
  } catch {
    return null
  }
}

/** Atomic 0600 write shared by the desktop server's login flow. */
export function writeDeepSeekOAuthTokenFile(
  filePath: string,
  tokens: DeepSeekOAuthTokens,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  let renamed = false
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, {
      mode: 0o600,
    })
    fs.renameSync(temporaryPath, filePath)
    renamed = true
  } finally {
    if (!renamed) fs.rmSync(temporaryPath, { force: true })
  }
}

/**
 * Forget the stored grant after the platform rejected it, but only while it
 * is still the rejected one: a login that completed meanwhile must survive a
 * late 401 from a request that used the previous token.
 */
export function clearRejectedDeepSeekToken(rejectedToken: string): boolean {
  const filePath = getDeepSeekOAuthTokenFilePath()
  if (!filePath) return false
  try {
    const current = normalizeTokenFile(
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
    )
    if (current?.token !== rejectedToken) return false
    fs.rmSync(filePath, { force: true })
    return true
  } catch {
    return false
  }
}

export function normalizeTokenFile(value: unknown): DeepSeekOAuthTokens | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const token = stringField(record.token)
  const issuer = stringField(record.issuer)
  const deviceId = stringField(record.deviceId)
  if (!token || !issuer || !deviceId) return null
  if (issuer !== getDeepSeekPlatformOrigin()) return null
  const name = stringField(record.name)
  const contact = stringField(record.contact)
  return {
    token,
    issuer,
    deviceId,
    ...(name ? { name } : {}),
    ...(contact ? { contact } : {}),
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
