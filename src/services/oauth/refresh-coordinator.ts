import * as lockfile from '../../utils/lockfile.js'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'

type TokenIdentity = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  clientId?: string | null
  accountId?: string | null
}

const flights = new Map<string, Promise<void>>()

export function oauthFileAuthority(filePath: string): string {
  const absolute = path.resolve(filePath)
  return `file:${process.platform === 'win32' ? absolute.toLowerCase() : absolute}`
}

// Desktop token files include nullable metadata that CLI readers omit. Compare
// credential identity rather than their different serialized representations.
export function oauthTokenIdentity(tokens: TokenIdentity | null): string {
  return JSON.stringify(tokens && [tokens.accessToken, tokens.refreshToken,
    tokens.expiresAt, tokens.clientId || null, tokens.accountId || null])
}

export async function coordinateOAuthRefresh(
  provider: string,
  authority: string,
  tokens: TokenIdentity,
  operation: (assertOwnership: () => void) => Promise<void>,
): Promise<void> {
  const key = JSON.stringify([provider, authority, oauthTokenIdentity(tokens)])
  const pending = flights.get(key)
  if (pending) return pending
  const flight = Promise.resolve().then(() => authority.startsWith('file:')
    ? withOAuthFileRefreshLock(authority.slice(5), operation)
    : operation(() => {}))
  flights.set(key, flight)
  try {
    await flight
  } finally {
    if (flights.get(key) === flight) flights.delete(key)
  }
}

// The desktop server and its CLI children share token files but not Promises.
// Only the lock owner refreshes; waiters re-read credentials in operation().
async function withOAuthFileRefreshLock(
  filePath: string,
  operation: (assertOwnership: () => void) => Promise<void>,
): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  let compromised: Error | undefined
  const release = await lockfile.lock(filePath, {
    realpath: false,
    lockfilePath: `${filePath}.refresh.lock`,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 60, minTimeout: 1_000, maxTimeout: 1_000, factor: 1 },
    onCompromised: error => { compromised = error },
  })
  try {
    await operation(() => {
      if (compromised) throw new Error('OAuth refresh lock was lost; retry the request')
    })
  } finally {
    await release().catch(error => { if (!compromised) throw error })
  }
}

// Keep the final comparison and atomic rename in the same event-loop turn, so
// a logout/new login in this process cannot interleave between them. This is
// not a cross-process CAS against writers that do not hold the refresh lock.
export function saveRefreshedOAuthFile(
  filePath: string,
  expected: TokenIdentity,
  updated: TokenIdentity,
): void {
  let current: TokenIdentity | null = null
  try {
    current = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (oauthTokenIdentity(current) !== oauthTokenIdentity(expected)) {
    throw new Error('OAuth credentials changed during refresh; retry the request')
  }
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}
