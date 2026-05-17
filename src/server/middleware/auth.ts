/**
 * Authentication middleware
 *
 * 本地桌面应用场景下，使用 Anthropic API Key 做简单鉴权。
 * 验证请求头中的 Authorization: Bearer <key> 与 .env 中的 ANTHROPIC_API_KEY 是否匹配。
 */

import { H5AccessService } from '../services/h5AccessService.js'

type AuthResult = { valid: boolean; error?: string }

function parseBearerToken(authHeader: string | null): AuthResult & { token?: string } {
  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' }
  }

  const [scheme, token] = authHeader.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return { valid: false, error: 'Invalid Authorization format. Use: Bearer <token>' }
  }

  return { valid: true, token }
}

export function validateAuth(req: Request): AuthResult {
  const parsedAuth = parseBearerToken(req.headers.get('Authorization'))
  if (!parsedAuth.valid || !parsedAuth.token) {
    return parsedAuth
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { valid: false, error: 'Server ANTHROPIC_API_KEY not configured' }
  }

  if (parsedAuth.token !== apiKey) {
    return { valid: false, error: 'Invalid API key' }
  }

  return { valid: true }
}

/**
 * Helper to check auth and return 401 if invalid
 */
export async function validateRequestAuth(
  req: Request,
  tokenOverride?: string | null,
): Promise<AuthResult> {
  const anthropicAuth = validateAuth(req)
  if (anthropicAuth.valid) {
    return anthropicAuth
  }

  const parsedAuth = parseBearerToken(req.headers.get('Authorization'))
  const h5Token = tokenOverride ?? parsedAuth.token
  if (h5Token) {
    const h5AccessService = new H5AccessService()
    if (await h5AccessService.validateToken(h5Token)) {
      return { valid: true }
    }
    return { valid: false, error: 'Invalid H5 access token' }
  }

  return anthropicAuth
}

export async function requireAuth(req: Request, tokenOverride?: string | null): Promise<Response | null> {
  const { valid, error } = await validateRequestAuth(req, tokenOverride)
  if (!valid) {
    return Response.json({ error: 'Unauthorized', message: error }, { status: 401 })
  }
  return null
}

export async function requireH5Token(req: Request, tokenOverride?: string | null): Promise<Response | null> {
  const parsedAuth = parseBearerToken(req.headers.get('Authorization'))
  const h5Token = tokenOverride ?? parsedAuth.token
  if (!h5Token) {
    return Response.json(
      { error: 'Unauthorized', message: 'Missing H5 access token' },
      { status: 401 },
    )
  }

  const h5AccessService = new H5AccessService()
  if (!await h5AccessService.validateToken(h5Token)) {
    return Response.json(
      { error: 'Unauthorized', message: 'Invalid H5 access token' },
      { status: 401 },
    )
  }

  return null
}
