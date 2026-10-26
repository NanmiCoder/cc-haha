import { scheduledTaskInputSchema } from '../../tools/ScheduledTaskTool/schema.js'
import { CronService, type CronTask } from '../services/cronService.js'
import type { CronScheduler } from '../services/cronScheduler.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

type Dependencies = {
  tasks: CronService
  runs: Pick<CronScheduler, 'getRunsPage' | 'getRunDetail'>
  sessionExists: (sessionId: string) => Promise<boolean>
}
const taskService = new CronService()

function taskResult(operation: 'created' | 'updated' | 'viewed' | 'deleted', task: CronTask) {
  return { schemaVersion: 1, kind: 'scheduled_task', operation, taskId: task.id, task }
}

/** callerSessionId is supplied exclusively by the host's SDK token authentication. */
export async function handleScheduledTaskToolsApi(req: Request, callerSessionId: string, dependencies?: Dependencies): Promise<Response> {
  try {
    if (req.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 })
    const raw: unknown = await req.json().catch(() => { throw ApiError.badRequest('A JSON object is required') })
    const parsed = scheduledTaskInputSchema.safeParse(raw)
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 2000))
    const input = parsed.data
    const deps = dependencies ?? {
      tasks: taskService,
      runs: (await import('../services/cronScheduler.js')).cronScheduler,
      sessionExists: async (id: string) => Boolean(await (await import('../services/sessionService.js')).sessionService.getSessionLaunchInfo(id)),
    }
    const getTask = async (id: string) => {
      const task = await deps.tasks.getTask(id)
      if (!task) throw ApiError.notFound(`Task not found: ${id}`)
      return task
    }
    const validateTarget = async (execution: { kind: string; targetSessionId?: string } | undefined) => {
      if (execution?.kind === 'session' && execution.targetSessionId !== callerSessionId && !await deps.sessionExists(execution.targetSessionId!)) {
        throw ApiError.notFound('Target conversation not found')
      }
    }
    switch (input.action) {
      case 'list': {
        const all = await deps.tasks.listTasks()
        const matches = input.scope === 'all' ? all : all.filter(task => task.sourceSessionId === callerSessionId || (task.execution?.kind === 'session' && task.execution.targetSessionId === callerSessionId))
        const offset = input.offset ?? 0
        const tasks = matches.slice(offset, offset + (input.limit ?? 100)).map(task => ({
          id: task.id, revision: task.revision, name: task.name,
          enabled: task.enabled, schedule: task.schedule, cron: task.cron,
          execution: task.execution, nextRunAt: task.nextRunAt,
          notificationPolicy: task.notificationPolicy,
          promptPreview: task.prompt.slice(0, 300),
        }))
        const nextOffset = offset + tasks.length
        return Response.json({ schemaVersion: 1, kind: 'scheduled_task_list', tasks, totalCount: matches.length, truncated: matches.length > nextOffset, ...(matches.length > nextOffset ? { nextOffset } : {}), currentTime: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      }
      case 'view': return Response.json(taskResult('viewed', await getTask(input.id)))
      case 'create': {
        const { action: _action, requestId, ...fields } = input
        const execution = fields.execution ?? { kind: 'session' as const, targetSessionId: callerSessionId }
        await validateTarget(execution)
        const notificationPolicy = fields.notificationPolicy ?? 'important'
        const task = await deps.tasks.createTask({
          ...fields, execution, enabled: fields.enabled ?? true, notificationPolicy,
          notification: fields.notification ?? { enabled: notificationPolicy !== 'none', channels: ['desktop'] },
        }, { sourceSessionId: callerSessionId, requestId })
        return Response.json(taskResult('created', task))
      }
      case 'update': {
        await validateTarget(input.changes.execution)
        return Response.json(taskResult('updated', await deps.tasks.updateTask(input.id, input.changes, { expectedRevision: input.expectedRevision })))
      }
      case 'delete': {
        const task = await getTask(input.id)
        // The read snapshot and delete are fenced against a concurrent edit.
        await deps.tasks.deleteTask(input.id, { expectedRevision: input.expectedRevision ?? task.revision })
        return Response.json(taskResult('deleted', task))
      }
      case 'runs': {
        const page = await deps.runs.getRunsPage({ taskId: input.taskId, limit: input.limit ?? 20, cursor: input.cursor, summaryOnly: true })
        return Response.json({ schemaVersion: 1, kind: 'scheduled_task_runs', operation: 'listed', taskId: input.taskId, ...page })
      }
      case 'run': {
        const run = await deps.runs.getRunDetail(input.runId)
        if (!run) throw ApiError.notFound(`Scheduled run not found: ${input.runId}`)
        const maxChars = input.maxChars ?? 8000
        const output = run.output ?? ''
        const error = run.error ?? ''
        const outputOffset = Math.min(input.outputOffset ?? 0, output.length)
        const errorOffset = Math.min(input.errorOffset ?? 0, error.length)
        const nextOutputOffset = Math.min(outputOffset + maxChars, output.length)
        const nextErrorOffset = Math.min(errorOffset + maxChars, error.length)
        return Response.json({
          schemaVersion: 1, kind: 'scheduled_task_runs', operation: 'viewed', taskId: run.taskId,
          runs: [{
            ...run, prompt: run.prompt.slice(0, 1000), promptTruncated: run.prompt.length > 1000,
            output: output.slice(outputOffset, nextOutputOffset), error: error.slice(errorOffset, nextErrorOffset),
            outputOffset, errorOffset, outputTotalChars: output.length, errorTotalChars: error.length,
            outputTruncated: nextOutputOffset < output.length, errorTruncated: nextErrorOffset < error.length,
            ...(nextOutputOffset < output.length ? { nextOutputOffset } : {}),
            ...(nextErrorOffset < error.length ? { nextErrorOffset } : {}),
          }],
        })
      }
      case 'report': {
        const { reportScheduledTaskNotificationDecision } = await import('../services/scheduledTaskNotificationDecision.js')
        await reportScheduledTaskNotificationDecision(input.runId, callerSessionId, input.decision)
        return Response.json({ schemaVersion: 1, kind: 'scheduled_task_notification', runId: input.runId, decision: input.decision })
      }
    }
  } catch (error) { return errorResponse(error) }
}
