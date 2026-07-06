/**
 * Authentication middleware
 *
 * 支持两种访问模式：
 * 1. 本地桌面应用：绑定 localhost，无需认证
 * 2. 公网/局域网访问：需要 SERVER_ACCESS_TOKEN 或 ANTHROPIC_API_KEY 认证
 */

// 获取有效的访问 token
function getValidAccessToken(): string | null {
  // 优先使用专用的访问 token
  const serverToken = process.env.SERVER_ACCESS_TOKEN
  if (serverToken && serverToken.trim().length > 0) {
    return serverToken
  }
  
  // 降级使用 Anthropic API Key
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey
  }
  
  return null
}

export function validateAuth(req: Request): { valid: boolean; error?: string } {
  const authHeader = req.headers.get('Authorization')

  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' }
  }

  const [scheme, token] = authHeader.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return { valid: false, error: 'Invalid Authorization format. Use: Bearer <token>' }
  }

  const validToken = getValidAccessToken()
  
  if (!validToken) {
    return { valid: false, error: 'Server not configured for authenticated access. Set SERVER_ACCESS_TOKEN or ANTHROPIC_API_KEY in environment.' }
  }

  if (token !== validToken) {
    return { valid: false, error: 'Invalid access token' }
  }

  return { valid: true }
}

/**
 * Helper to check auth and return 401 if invalid
 */
export function requireAuth(req: Request): Response | null {
  const { valid, error } = validateAuth(req)
  if (!valid) {
    return Response.json({ error: 'Unauthorized', message: error }, { status: 401 })
  }
  return null
}

/**
 * Check if we need to skip auth for health check endpoint
 */
export function shouldSkipAuth(url: URL): boolean {
  // Health check should always be accessible for monitoring
  return url.pathname === '/health'
}
