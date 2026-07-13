export type GrokOAuthTokenResponse = {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

export type GrokOAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  idToken?: string
  email?: string
  clientId?: string
  scope?: string
  tokenType?: string
}

export type GrokJwtClaims = {
  email?: string
}
