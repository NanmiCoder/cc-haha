import { timingSafeEqual } from 'node:crypto'
import { isLoopbackHost } from './h5AccessPolicy.js'

export const LOCAL_ACCESS_TOKEN_ENV = 'CC_HAHA_LOCAL_ACCESS_TOKEN'
export const PET_ACCESS_TOKEN_ENV = 'CC_HAHA_PET_ACCESS_TOKEN'
/** Per-launch credential of the desktop's P2P endpoint link (set by Electron). */
export const P2P_ENDPOINT_TOKEN_ENV = 'CC_HAHA_P2P_ENDPOINT_TOKEN'

function configuredAccessToken(envName: string): string | null {
  const token = process.env[envName]?.trim()
  return token || null
}

function configuredLocalAccessToken(): string | null {
  return configuredAccessToken(LOCAL_ACCESS_TOKEN_ENV)
}

function configuredPetAccessToken(): string | null {
  return configuredAccessToken(PET_ACCESS_TOKEN_ENV)
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization')
  if (!authorization) return null
  const [scheme, token] = authorization.split(' ')
  return scheme === 'Bearer' && token ? token : null
}

export function hasConfiguredLocalAccessToken(): boolean {
  return configuredLocalAccessToken() !== null
}

export function hasConfiguredPetAccessToken(): boolean {
  return configuredPetAccessToken() !== null
}

export function isLocalAccessAuthorized(
  request: Request,
  tokenOverride?: string | null,
): boolean {
  const expected = configuredLocalAccessToken()
  if (!expected) return false

  const candidate = tokenOverride ?? bearerToken(request)
  return candidate ? tokensEqual(candidate, expected) : false
}

/**
 * The desktop's WebRTC endpoint (a hidden window) relays P2P frames only, so it
 * holds its own token instead of the local access token that opens every
 * local API. Loopback only; without the variable the link stays closed.
 */
export function isP2PEndpointAuthorized(token: string | null, address: string): boolean {
  const expected = configuredAccessToken(P2P_ENDPOINT_TOKEN_ENV)
  return !!expected && !!token && isLoopbackHost(address) && tokensEqual(token, expected)
}

export function isPetAccessAuthorized(
  request: Request,
  tokenOverride?: string | null,
): boolean {
  const expected = configuredPetAccessToken()
  if (!expected) return false

  const candidate = tokenOverride ?? bearerToken(request)
  return candidate ? tokensEqual(candidate, expected) : false
}
