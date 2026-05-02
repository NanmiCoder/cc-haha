/**
 * GitHub API — Token management and repo subscription
 *
 * Routes:
 *   GET    /api/github/status  — Check token status
 *   POST   /api/github/token   — Verify and save PAT
 *   DELETE /api/github/token   — Remove stored token
 */

import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const GITHUB_API_USER_URL = 'https://api.github.com/user'

/** Secure storage data key for GitHub credentials */
const GITHUB_CREDENTIALS_KEY = 'githubCredentials'

type GitHubCredentials = {
  pat: string
  username: string
  avatar?: string
}

class RedactedGithubToken {
  readonly #value: string
  constructor(raw: string) {
    this.#value = raw
  }
  reveal(): string {
    return this.#value
  }
  toString(): string {
    return '[REDACTED:gh-token]'
  }
  toJSON(): string {
    return '[REDACTED:gh-token]'
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED:gh-token]'
  }
}

async function verifyGitHubToken(token: string): Promise<{ login: string; avatar_url?: string }> {
  const response = await fetch(GITHUB_API_USER_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiError(401, 'Invalid or expired GitHub token', 'UNAUTHORIZED')
    }
    throw ApiError.internal(`GitHub API error: ${response.status} ${response.statusText}`)
  }

  return response.json() as Promise<{ login: string; avatar_url?: string }>
}

function getStoredCredentials(): GitHubCredentials | null {
  try {
    const storage = getSecureStorage()
    const data = storage.read()
    if (!data) return null
    const creds = data[GITHUB_CREDENTIALS_KEY]
    if (
      creds &&
      typeof creds === 'object' &&
      'pat' in creds &&
      typeof (creds as GitHubCredentials).pat === 'string' &&
      'username' in creds &&
      typeof (creds as GitHubCredentials).username === 'string'
    ) {
      return creds as GitHubCredentials
    }
    return null
  } catch {
    return null
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleGetStatus(): Promise<Response> {
  const creds = getStoredCredentials()
  if (!creds) {
    return Response.json({ connected: false })
  }
  return Response.json({
    connected: true,
    username: creds.username,
    avatar: creds.avatar,
  })
}

async function handleSaveToken(req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  const token = body.token
  if (typeof token !== 'string' || !token.trim()) {
    throw ApiError.badRequest('Missing or invalid "token" in request body')
  }

  // Verify token with GitHub API
  const redacted = new RedactedGithubToken(token.trim())
  let userInfo: { login: string; avatar_url?: string }
  try {
    userInfo = await verifyGitHubToken(redacted.reveal())
  } catch (err) {
    // Re-throw API errors but ensure token is never logged
    throw err
  }

  // Store in secure storage
  const storage = getSecureStorage()
  const current = storage.read() || {}
  const result = storage.update({
    ...current,
    [GITHUB_CREDENTIALS_KEY]: {
      pat: token.trim(),
      username: userInfo.login,
      avatar: userInfo.avatar_url,
    },
  })

  if (!result.success) {
    throw ApiError.internal('Failed to save GitHub token to secure storage')
  }

  return Response.json({
    ok: true,
    username: userInfo.login,
    avatar: userInfo.avatar_url,
  })
}

async function handleDeleteToken(): Promise<Response> {
  const storage = getSecureStorage()
  const current = storage.read() || {}
  if (GITHUB_CREDENTIALS_KEY in current) {
    const { [GITHUB_CREDENTIALS_KEY]: _, ...rest } = current
    storage.update(rest)
  }
  return Response.json({ ok: true })
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function handleGitHubApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2]

    if (action === 'status' && req.method === 'GET') {
      return await handleGetStatus()
    }

    if (action === 'token' && req.method === 'POST') {
      return await handleSaveToken(req)
    }

    if (action === 'token' && req.method === 'DELETE') {
      return await handleDeleteToken()
    }

    throw ApiError.notFound(`Unknown GitHub API action: ${action}`)
  } catch (error) {
    return errorResponse(error)
  }
}
