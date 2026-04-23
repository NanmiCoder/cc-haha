/**
 * Haha OAuth REST API
 *
 * POST   /api/haha-oauth/start    — 生成 PKCE+state,返回 authorize URL
 * GET    /callback                — 用户浏览器 redirect 到此,完成 token 交换
 * GET    /api/haha-oauth/callback — 兼容旧路径
 * GET    /api/haha-oauth          — 查询当前登录状态(不回传 token 本体)
 * GET    /api/haha-oauth/status   — 同上(legacy path)
 * DELETE /api/haha-oauth          — 登出,删除 token 文件
 */

import { z } from 'zod'
import { hahaOAuthService } from '../services/hahaOAuthService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const StartRequestSchema = z.object({
  serverPort: z.number().int().positive(),
})

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export async function handleHahaOAuthApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2] // segments: ['api', 'haha-oauth', <action?>]

    if (action === 'start' && req.method === 'POST') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        throw ApiError.badRequest('Invalid JSON body')
      }
      const parsed = StartRequestSchema.safeParse(body)
      if (!parsed.success) {
        throw ApiError.badRequest('serverPort (positive integer) required')
      }
      const session = hahaOAuthService.startSession({
        serverPort: parsed.data.serverPort,
      })
      return Response.json({
        authorizeUrl: session.authorizeUrl,
        state: session.state,
      })
    }

    if (action === 'callback' && req.method === 'GET') {
      return handleHahaOAuthCallback(url)
    }

    if ((action === undefined || action === 'status') && req.method === 'GET') {
      const tokens = await hahaOAuthService.ensureFreshTokens()
      if (!tokens) {
        return Response.json({ loggedIn: false })
      }
      return Response.json({
        loggedIn: true,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        subscriptionType: tokens.subscriptionType,
      })
    }

    if (action === undefined && req.method === 'DELETE') {
      await hahaOAuthService.deleteTokens()
      return Response.json({ ok: true })
    }

    return Response.json({ error: 'Not Found' }, { status: 404 })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function handleHahaOAuthCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return html(renderCallbackPage(false, `OAuth provider returned: ${error}`))
  }
  if (!code || !state) {
    return html(renderCallbackPage(false, 'Missing code or state parameter'))
  }

  try {
    await hahaOAuthService.completeSession(code, state)
    return html(renderCallbackPage(true, null))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return html(renderCallbackPage(false, msg))
  }
}

function renderCallbackPage(success: boolean, errorMsg: string | null): string {
  if (success) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Login Success</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#16a34a;margin:0 0 12px}p{color:#666}</style>
</head><body><div class="card"><h1>✓ Login Successful</h1><p>You can close this window and return to Claude Code Haha.</p></div>
<script>setTimeout(() => window.close(), 1500)</script>
</body></html>`
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Login Failed</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#dc2626;margin:0 0 12px}pre{color:#666;white-space:pre-wrap;word-break:break-word;text-align:left;background:#f5f5f5;padding:12px;border-radius:6px}</style>
</head><body><div class="card"><h1>✗ Login Failed</h1><pre>${escapeHtml(errorMsg ?? 'Unknown error')}</pre></div>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
