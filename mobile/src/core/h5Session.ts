import { isLocalHostname } from './connection'
import type { Host } from './types'

/**
 * H5: the desktop server hosts this web version for phone browsers. The page's computer is the only computer, 
 * with no add, switch or pair steps — the connection is done by the desktop H5 entry (token page, remote pairing page)
 * and here we only reuse the credential it already verified.
 */

/** The two keys written after the desktop H5 entry verifies the token; see desktop/src/lib/desktopRuntime.ts. */
export const H5_SERVER_URL_STORAGE_KEY = 'cc-haha-h5-server-url'
export const H5_TOKEN_STORAGE_KEY = 'cc-haha-h5-token'
export const H5_HOST_ID = 'h5'
export const H5_HOST_NAME = 'This computer'

export type H5Location = { origin: string; hostname: string }
export type H5Storage = { getItem(key: string): string | null }

/**
 * Connection methods the page can use directly, by priority: 
 * - token: LAN H5, an access token for this address verified by the desktop entry; 
 * - cookie: remote browser, a device cookie set by the server after pairing via the desktop entry, sent by the browser itself; 
 * - loopback: opened on this very computer; the server trusts loopback addresses and needs no credentials.
 */
export type H5Credential =
  | { kind: 'token'; token: string }
  | { kind: 'cookie' }
  | { kind: 'loopback' }

/** Only take tokens for the current address: a token is only valid for the server that verified it. */
export function storedH5Token(location: H5Location, storage: H5Storage | null): string | null {
  if (!storage) return null
  let serverUrl: string | null
  let token: string | null
  try {
    serverUrl = storage.getItem(H5_SERVER_URL_STORAGE_KEY)
    token = storage.getItem(H5_TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
  const value = token?.trim()
  if (!value || /\s|[\u0000-\u001f\u007f]/.test(value)) return null
  return normalizeOrigin(serverUrl) === location.origin ? value : null
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)
}

/**
 * the page's computer. `auth` keeps the native app meaning: remote means accessed through the public gateway
 * (home shows "Public" and reads the auth expiry), everything else is lan.
 */
export function h5Host(location: H5Location, credential: H5Credential): Host {
  return {
    id: H5_HOST_ID,
    name: H5_HOST_NAME,
    url: location.origin,
    auth: credential.kind === 'cookie' && !isLocalHostname(location.hostname) ? 'remote' : 'lan',
    page: true,
  }
}

/** Credential string carried in requests and WebSocket; cookies and loopback need none. */
export function h5CredentialValue(credential: H5Credential): string {
  return credential.kind === 'token' ? credential.token : ''
}

/**
 * When credentials are invalid or missing return to the desktop H5 entry: it has the token page and remote pairing page and sends back afterwards.
 * The LAN entry adds `reconnect`: the desktop index.html redirects phones with a stored token straight back here, 
 * and only re-verifies the token with the param (invalid tokens are cleared there and the token page is shown).
 */
export function h5EntryUrl(location: H5Location, remote: boolean): string {
  return `${location.origin}${remote ? '/remote' : '/?reconnect=1'}`
}

type SessionProbe = (
  url: string,
  init: { credentials: 'same-origin'; redirect: 'error'; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export type H5Resolution =
  | { credential: H5Credential; host: Host }
  /** This page is not connected yet: go back to the desktop entry (token page on LAN, pairing page on the remote gateway). */
  | { entry: string }

/**
 * Decide which credential the page uses to connect to the computer. Tokens need no request to decide; without a token ask once
 * The remote gateway session endpoint — only the gateway answers it (the main server rejects browsers outright), 
 * so answering "not logged in" means this is an unpaired browser on the remote gateway.
 */
export async function resolveH5Session(input: {
  location: H5Location
  storage: H5Storage | null
  fetch: SessionProbe
  signal?: AbortSignal
}): Promise<H5Resolution> {
  const { location } = input
  const token = storedH5Token(location, input.storage)
  if (token) {
    const credential = { kind: 'token', token } as const
    return { credential, host: h5Host(location, credential) }
  }
  let gateway = false
  try {
    const response = await input.fetch(`${location.origin}/api/public-access/session`, {
      credentials: 'same-origin',
      redirect: 'error',
      signal: input.signal,
    })
    if (response.ok) {
      gateway = true
      const session = (await response.json()) as { authenticated?: unknown } | null
      if (session?.authenticated === true) {
        const credential = { kind: 'cookie' } as const
        return { credential, host: h5Host(location, credential) }
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    // On network failure do not decide whether it is the gateway; loopback addresses can still connect directly.
  }
  if (!gateway && isLoopbackHostname(location.hostname)) {
    const credential = { kind: 'loopback' } as const
    return { credential, host: h5Host(location, credential) }
  }
  return { entry: h5EntryUrl(location, gateway) }
}
