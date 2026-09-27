/**
 * Teams REST API
 *
 * GET    /api/teams                                — 列出所有团队
 * GET    /api/teams/session/:id/workbench           — 获取主会话的实时或归档工作台
 * GET    /api/teams/:name                          — 获取团队详情
 * GET    /api/teams/:name/workbench                — 获取协作工作台只读快照
 * GET    /api/teams/:name/members/:id/transcript   — 获取成员 transcript
 * POST   /api/teams/:name/members/:id/messages     — 给成员发送消息
 * DELETE /api/teams/:name                          — 删除团队
 */

import { teamPlanActionSchema, teamPlanPatchRequestSchema, teamPlanService } from '../services/teamPlanService.js'
import { TeamPlanError } from '../../utils/swarm/teamPlanStore.js'
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

    if (method === 'GET' && teamName === 'session' && segments[3] && segments[4] === 'plan') {
      return Response.json({ plan: await teamPlanService.getForSession(decodeURIComponent(segments[3])) })
    }
    if (teamName && segments[3] === 'plan' && (method === 'PATCH' || method === 'POST')) {
      let raw: unknown
      try { raw = await req.json() } catch { throw ApiError.badRequest('Invalid JSON body') }
      if (method === 'PATCH') {
        const parsed = teamPlanPatchRequestSchema.safeParse(raw)
        if (!parsed.success) throw ApiError.badRequest('Invalid team plan update')
        const { members, tasks, ...identity } = parsed.data
        const plan = await teamPlanService.update(teamName, identity, {
          ...(members ? { members } : {}), ...(tasks ? { tasks } : {}),
        })
        return Response.json({ plan })
      }
      const parsed = teamPlanActionSchema.safeParse(raw)
      if (!parsed.success) throw ApiError.badRequest('Invalid team plan action')
      const action = segments[4]
      if (action === 'approve') return Response.json({ plan: await teamPlanService.approve(teamName, parsed.data) })
      if (action === 'return' || action === 'cancel' || action === 'retry') return Response.json({ plan: await teamPlanService.action(teamName, action, parsed.data) })
      throw ApiError.badRequest('Unknown team plan action')
    }

    // ── GET /api/teams ────────────────────────────────────────────────────
    if (method === 'GET' && !teamName) {
      const teams = await teamService.listTeams()
      return Response.json({ teams })
    }

    // ── GET /api/teams/session/:id/workbench ──────────────────────────────
    if (
      method === 'GET' &&
      teamName === 'session' &&
      segments[3] &&
      segments[4] === 'workbench'
    ) {
      const sessionId = decodeURIComponent(segments[3])
      const lookupUrl = new URL(req.url)
      const rawAt = lookupUrl.searchParams.get('at')
      const at = rawAt === null ? undefined : Number(rawAt)
      const timeline = await teamService.getWorkbenchForSession(sessionId, {
        teamName: lookupUrl.searchParams.get('teamName') || undefined,
        incarnationId: lookupUrl.searchParams.get('incarnationId') || undefined,
        ...(at !== undefined && Number.isFinite(at) ? { at } : {}),
      })
      if (!timeline) {
        throw ApiError.notFound(`No Agent Teams workbench for session: ${sessionId}`)
      }
      return Response.json(timeline)
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
      const url = new URL(req.url)
      if (url.searchParams.get('incremental') === 'true') {
        const rawAfterOrdinal = url.searchParams.get('afterOrdinal')
        const parsedAfterOrdinal = rawAfterOrdinal === null
          ? undefined
          : Number.parseInt(rawAfterOrdinal, 10)
        const page = await teamService.getMemberTranscriptPage(teamName, agentId, {
          leadSessionId: url.searchParams.get('leadSessionId') || undefined,
          incarnationId: url.searchParams.get('incarnationId') || undefined,
          signature: url.searchParams.get('signature') || undefined,
          cursor: url.searchParams.get('cursor') || undefined,
          afterOrdinal: parsedAfterOrdinal !== undefined && Number.isSafeInteger(parsedAfterOrdinal)
            ? parsedAfterOrdinal
            : undefined,
        })
        return Response.json(page)
      }
      const page = await teamService.getMemberTranscriptPage(teamName, agentId, {
        leadSessionId: url.searchParams.get('leadSessionId') || undefined,
        incarnationId: url.searchParams.get('incarnationId') || undefined,
      })
      return Response.json({
        messages: page.messages,
        ownerAgentIds: page.ownerAgentIds,
        taskNotifications: page.taskNotifications,
        taskAnchors: page.taskAnchors,
      })
    }

    // ── GET /api/teams/:name/workbench ────────────────────────────────────
    if (method === 'GET' && teamName && segments[3] === 'workbench') {
      const snapshot = await teamService.getWorkbench(teamName)
      return Response.json(snapshot)
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
    if (error instanceof TeamPlanError) return errorResponse(new ApiError(error.status, error.message, 'TEAM_PLAN_CONFLICT'))
    return errorResponse(error)
  }
}
