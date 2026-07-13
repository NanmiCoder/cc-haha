import { timingSafeEqual } from 'node:crypto'

export const LOCAL_ACCESS_TOKEN_ENV = 'CC_HAHA_LOCAL_ACCESS_TOKEN'

function configuredLocalAccessToken(): string | null {
  const token = process.env[LOCAL_ACCESS_TOKEN_ENV]?.trim()
  return token || null
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

export function isLocalAccessAuthorized(
  request: Request,
  tokenOverride?: string | null,
): boolean {
  const expected = configuredLocalAccessToken()
  if (!expected) return false

  const candidate = tokenOverride ?? bearerToken(request)
  return candidate ? tokensEqual(candidate, expected) : false
}
