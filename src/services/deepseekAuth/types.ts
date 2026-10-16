/**
 * DeepSeek account grant. The platform issues one opaque token per login; it
 * has no refresh token and no expiry, so it stays valid until the user signs
 * out or the platform rejects it with HTTP 401.
 */
export type DeepSeekOAuthTokens = {
  token: string
  /** Platform origin that issued the token; a token is only ever replayed to its issuer's inference origin. */
  issuer: string
  deviceId: string
  name?: string | null
  /** Masked email or mobile as returned by the platform, shown in settings. */
  contact?: string | null
}

export type DeepSeekAuthInit = {
  authorizeUrl: string
  authorizeId: string
  expiresInSeconds: number
}

export type DeepSeekAuthExchange = {
  token: string
  authorizedUrl: string
  name: string | null
  contact: string | null
}

export type DeepSeekClientIdentity = {
  version: string
  locale: string
  timezoneOffsetSeconds: number
}
