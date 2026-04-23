/**
 * Status REST API
 *
 * GET /api/status              — 健康检查
 * GET /api/status/diagnostics  — 系统诊断信息
 * GET /api/status/usage        — Token 用量（当前会话累计）
 * GET /api/status/user         — 用户信息
 */

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

// 服务器启动时间（用于计算 uptime）
const startedAt = Date.now()

// 会话级别的 token 用量累计（进程生命周期内）
const usage = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
}

/** 供外部累加 token 用量 */
export function addUsage(input: number, output: number, cost: number) {
  usage.totalInputTokens += input
  usage.totalOutputTokens += output
  usage.totalCost += cost
}

/** 重置用量（测试用） */
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
  // 从 package.json 的 version 字段读取；回退到环境变量或 unknown
  return process.env.APP_VERSION || '999.0.0-local'
}

/**
 * 扫描 configDir 下的 projects 目录，返回已知的项目路径列表。
 * 如果目录不存在，返回空数组。
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
