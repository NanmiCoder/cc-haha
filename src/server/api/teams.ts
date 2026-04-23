/**
 * Teams REST API
 *
 * GET    /api/teams                                — 列出所有团队
 * GET    /api/teams/:name                          — 获取团队详情
 * GET    /api/teams/:name/members/:id/transcript   — 获取成员 transcript
 * POST   /api/teams/:name/members/:id/messages     — 给成员发送消息
 * DELETE /api/teams/:name                          — 删除团队
 */

import { teamService } from '../services/teamService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

export async function handleTeamsApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const teamName = segments[2] ? decodeURIComponent(segments[2]) : undefined

    // ── GET /api/teams ────────────────────────────────────────────────────
    if (method === 'GET' && !teamName) {
      const teams = await teamService.listTeams()
      return Response.json({ teams })
    }

    // ── GET /api/teams/:name/members/:id/transcript ───────────────────────
    if (
      method === 'GET' &&
      teamName &&
      segments[3] === 'members' &&
      segments[4] &&
      segments[5] === 'transcript'
    ) {
      const agentId = decodeURIComponent(segments[4])
      const messages = await teamService.getMemberTranscript(teamName, agentId)
      return Response.json({ messages })
    }

    // ── POST /api/teams/:name/members/:id/messages ─────────────────────────
    if (
      method === 'POST' &&
      teamName &&
      segments[3] === 'members' &&
      segments[4] &&
      segments[5] === 'messages'
    ) {
      const agentId = decodeURIComponent(segments[4])
      let body: { content?: string }
      try {
        body = (await req.json()) as { content?: string }
      } catch {
        throw ApiError.badRequest('Invalid JSON body')
      }

      await teamService.sendMemberMessage(teamName, agentId, body.content ?? '')
      return Response.json({ ok: true })
    }

    // ── GET /api/teams/:name ──────────────────────────────────────────────
    if (method === 'GET' && teamName) {
      const team = await teamService.getTeam(teamName)
      return Response.json(team)
    }

    // ── DELETE /api/teams/:name ───────────────────────────────────────────
    if (method === 'DELETE' && teamName) {
      await teamService.deleteTeam(teamName)
      return Response.json({ ok: true })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/teams${teamName ? `/${teamName}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
