/**
 * 终端 REST API（H5 终端桥接）
 *
 * GET  /api/terminal/bash-path — 读取 bash 路径（与桌面端 terminal-config.json 共享）
 * PUT  /api/terminal/bash-path — 写入 bash 路径（{bashPath: string|null}，null 清除）
 *
 * 交互式 PTY 本身走 /ws/terminal（见 ws/handler.ts terminal 分支），
 * 这里只承载 bash 路径这一项设置面的读写。
 */

import { getTerminalService } from '../services/terminalService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

export async function handleTerminalApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]
    if (sub !== 'bash-path') {
      throw ApiError.notFound(`Unknown terminal endpoint: ${sub}`)
    }

    const terminalService = getTerminalService()

    if (req.method === 'GET') {
      return Response.json({ bashPath: terminalService.getBashPath() })
    }

    if (req.method === 'PUT') {
      const body = await parseJsonBody(req)
      const bashPath = body.bashPath
      if (bashPath !== null && typeof bashPath !== 'string') {
        throw ApiError.badRequest('"bashPath" must be a string or null')
      }
      terminalService.setBashPath(bashPath)
      return Response.json({ ok: true, bashPath: terminalService.getBashPath() })
    }

    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}
