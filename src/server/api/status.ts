/**
 * Status REST API
 *
 * GET /api/status              — health check
 * GET /api/status/diagnostics  — system diagnostics
 * GET /api/status/usage        — token usage (accumulated for the current session)
 * GET /api/status/user         — user info
 */

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

// Server start time (for computing uptime)
const startedAt = Date.now()

// Session-level token usage accumulated (for the process lifetime)
const usage = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
}

/** Lets external callers accumulate token usage */
export function addUsage(input: number, output: number, cost: number) {
  usage.totalInputTokens += input
  usage.totalOutputTokens += output
  usage.totalCost += cost
}

/** Reset usage (for tests) */
export function resetUsage() {
  usage.totalInputTokens = 0
  usage.totalOutputTokens = 0
  usage.totalCost = 0
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleStatusApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (req.method !== 'GET') {
      throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
    }

    const sub = segments[2] // 'diagnostics' | 'usage' | 'user' | undefined

    switch (sub) {
      case undefined:
        return handleHealthCheck()

      case 'diagnostics':
        return handleDiagnostics()

      case 'usage':
        return handleUsage()

      case 'user':
        return await handleUser()

      default:
        throw ApiError.notFound(`Unknown status endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleHealthCheck(): Response {
  return Response.json({
    status: 'ok',
    version: getVersion(),
    uptime: Date.now() - startedAt,
  })
}

function handleDiagnostics(): Response {
  return Response.json({
    nodeVersion: process.version,
    bunVersion: typeof Bun !== 'undefined' ? Bun.version : 'N/A',
    platform: process.platform,
    arch: process.arch,
    configDir: getConfigDir(),
    memory: {
      rss: process.memoryUsage.rss(),
      heapUsed: process.memoryUsage().heapUsed,
      heapTotal: process.memoryUsage().heapTotal,
    },
  })
}

function handleUsage(): Response {
  return Response.json({
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalCost: usage.totalCost,
  })
}

async function handleUser(): Promise<Response> {
  const configDir = getConfigDir()
  const projects = await discoverProjects(configDir)

  return Response.json({
    configDir,
    projects,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function getVersion(): string {
  // Read from package.json's version field; fall back to an environment variable or unknown
  return process.env.APP_VERSION || '999.0.0-local'
}

/**
 * Scan the projects directory under configDir and return the list of known project paths.
 * Returns an empty array if the directory does not exist.
 */
async function discoverProjects(configDir: string): Promise<string[]> {
  const projectsDir = path.join(configDir, 'projects')
  try {
    const entries = await fs.readdir(projectsDir)
    return entries.filter((e) => !e.startsWith('.'))
  } catch {
    return []
  }
}
