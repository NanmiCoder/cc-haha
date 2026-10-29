/**
 * Scheduled Tasks REST API
 *
 * GET    /api/scheduled-tasks           — 获取任务列表
 * GET    /api/scheduled-tasks/notification-capabilities — 通知渠道配置状态
 * POST   /api/scheduled-tasks           — 创建任务
 * GET    /api/scheduled-tasks/runs      — 获取所有任务的最近执行记录
 * GET    /api/scheduled-tasks/:id/runs  — 获取指定任务的执行记录
 * POST   /api/scheduled-tasks/:id/run   — 立即执行指定任务
 * PUT    /api/scheduled-tasks/:id       — 更新任务
 * DELETE /api/scheduled-tasks/:id       — 删除任务
 */

import { z } from 'zod/v4'
import { CronService } from '../services/cronService.js'
import { cronScheduler } from '../services/cronScheduler.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { scheduledTaskEditableSchema } from '../../tools/ScheduledTaskTool/schema.js'
import { getScheduledTaskNotificationCapabilities } from '../services/scheduledTaskNotificationCapabilities.js'

const cronService = new CronService()
const taskMutationSchema = scheduledTaskEditableSchema.extend({
  description: z.string().max(32_000).optional(),
  cron: z.string().trim().min(1).max(200).optional(),
  recurring: z.boolean().optional(), permanent: z.boolean().optional(),
  permissionMode: z.string().max(100).optional(), model: z.string().max(200).optional(),
  providerId: z.string().max(200).nullable().optional(), folderPath: z.string().max(4096).optional(),
  useWorktree: z.boolean().optional(),
  notification: z.strictObject({ enabled: z.boolean(), channels: z.array(z.enum(['desktop', 'telegram', 'feishu'])).max(3) }).optional(),
  expectedRevision: z.number().int().positive().optional(),
})

export async function handleScheduledTasksApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const taskId = segments[2] // /api/scheduled-tasks/:id  or "runs"
    const subResource = segments[3] // /api/scheduled-tasks/:id/runs

    if (taskId === 'notification-capabilities') {
      if (method !== 'GET' || segments.length !== 3 || _url.search) {
        throw new ApiError(405, 'Notification capabilities are read-only', 'METHOD_NOT_ALLOWED')
      }
      return Response.json(await getScheduledTaskNotificationCapabilities())
    }

    // ── GET /api/scheduled-tasks/runs ────────────────────────────────────
    if (method === 'GET' && taskId === 'runs' && subResource) {
      const run = await cronScheduler.getRunDetail(subResource)
      if (!run) throw ApiError.notFound(`Scheduled run ${subResource} not found`)
      return Response.json({ run })
    }

    if (method === 'GET' && taskId === 'runs') {
      const url = new URL(req.url)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const cursor = url.searchParams.get('cursor') || undefined
      const summaryOnly = url.searchParams.get('summaryOnly') === 'true'
      const nonterminalOnly = url.searchParams.get('nonterminalOnly') === 'true'
      const completedAfterParam = url.searchParams.get('completedAfterMs')
      const completedAfterMs = completedAfterParam === null
        ? undefined
        : Number(completedAfterParam)
      if (completedAfterMs !== undefined && (!Number.isFinite(completedAfterMs) || completedAfterMs < 0)) {
        throw ApiError.badRequest('Invalid completedAfterMs parameter')
      }
      if (!cursor && !summaryOnly && !nonterminalOnly && completedAfterMs === undefined) {
        const runs = await cronScheduler.getRecentRuns(limit)
        return Response.json({ runs })
      }
      return Response.json(await cronScheduler.getRunsPage({
        limit,
        cursor,
        summaryOnly,
        nonterminalOnly,
        completedAfterMs,
      }))
    }

    // ── GET /api/scheduled-tasks/:id/runs ────────────────────────────────
    if (method === 'GET' && taskId && subResource === 'runs') {
      const url = new URL(req.url)
      const cursor = url.searchParams.get('cursor') || undefined
      const limitParam = url.searchParams.get('limit')
      const summaryOnly = url.searchParams.get('summaryOnly') === 'true'
      const nonterminalOnly = url.searchParams.get('nonterminalOnly') === 'true'
      const completedAfterParam = url.searchParams.get('completedAfterMs')
      const completedAfterMs = completedAfterParam === null
        ? undefined
        : Number(completedAfterParam)
      if (completedAfterMs !== undefined && (!Number.isFinite(completedAfterMs) || completedAfterMs < 0)) {
        throw ApiError.badRequest('Invalid completedAfterMs parameter')
      }
      if (!cursor && !limitParam && !summaryOnly && !nonterminalOnly && completedAfterMs === undefined) {
        const runs = await cronScheduler.getTaskRuns(taskId)
        return Response.json({ runs })
      }
      const limit = parseInt(limitParam || '50', 10)
      return Response.json(await cronScheduler.getRunsPage({
        taskId,
        limit,
        cursor,
        summaryOnly,
        nonterminalOnly,
        completedAfterMs,
      }))
    }

    // ── GET /api/scheduled-tasks ──────────────────────────────────────────
    if (method === 'GET' && !taskId) {
      const tasks = await cronService.listTasks()
      return Response.json({ tasks })
    }

    // ── POST /api/scheduled-tasks ─────────────────────────────────────────
    if (method === 'POST' && !taskId) {
      const { expectedRevision: _revision, ...body } = await parseJsonBody(req)
      if (!body.prompt) throw ApiError.badRequest('prompt is required')
      const task = await cronService.createTask({ ...body, prompt: body.prompt })
      return Response.json({ task }, { status: 201 })
    }

    // ── POST /api/scheduled-tasks/:id/run ──────────────────────────────────
    // Fire-and-forget: start execution in background, return immediately.
    // The frontend polls GET /:id/runs to track progress.
    if (method === 'POST' && taskId && subResource === 'run') {
      const tasks = await cronService.listTasks()
      const task = tasks.find((t) => t.id === taskId)
      if (!task) throw ApiError.notFound(`Task ${taskId} not found`)
      cronScheduler.executeTask(task, { createSession: true }).catch((err) => {
        console.error(`[ScheduledTasks] Manual run failed for task ${taskId}:`, err)
      })
      // Small delay to let appendRun() write the "running" entry to disk
      await new Promise((r) => setTimeout(r, 200))
      return Response.json({ ok: true })
    }

    // ── PUT /api/scheduled-tasks/:id ──────────────────────────────────────
    if (method === 'PUT' && taskId && !subResource) {
      const { expectedRevision, ...body } = await parseJsonBody(req)
      const task = await cronService.updateTask(taskId, body, { expectedRevision })
      return Response.json({ task })
    }

    // ── DELETE /api/scheduled-tasks/:id ───────────────────────────────────
    if (method === 'DELETE' && taskId && !subResource) {
      await cronService.deleteTask(taskId)
      return Response.json({ ok: true })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/scheduled-tasks${taskId ? `/${taskId}` : ''}${subResource ? `/${subResource}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<z.infer<typeof taskMutationSchema>> {
  let value: unknown
  try {
    value = await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  const parsed = taskMutationSchema.safeParse(value)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 2000))
  return parsed.data
}
