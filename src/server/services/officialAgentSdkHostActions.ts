import { z } from 'zod/v4'
import { computeNextCronRun, parseCronExpression } from '../../utils/cron.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { ApiError } from '../middleware/errorHandler.js'
import { conversationService } from './conversationService.js'
import { CronService, type CronTask } from './cronService.js'
import { readConversationRuntime } from './officialAgentSdkRuntime.js'
import { ProviderService } from './providerService.js'
import { sessionService } from './sessionService.js'
import { isSideChatId } from './sideChatRegistry.js'
import { teamService } from './teamService.js'

const cronService = new CronService()
const providerService = new ProviderService()
const cron = z.string().trim().min(1).max(200).refine(value => {
  const parsed = parseCronExpression(value)
  return Boolean(parsed && computeNextCronRun(parsed, new Date()))
}, 'Expected a valid five-field cron expression with a future occurrence')
const fields = {
  name: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(32_000),
  cron,
  recurring: z.boolean().optional(),
}
const createSchema = z.strictObject(fields)
const updateSchema = z.strictObject({
  ...fields, prompt: fields.prompt.optional(), cron: cron.optional(),
  enabled: z.boolean().optional(), taskId: z.string().min(1).max(200),
})
const deleteSchema = z.strictObject({ taskId: z.string().min(1).max(200) })
const teamDeleteSchema = z.strictObject({ teamName: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) })

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw ApiError.badRequest(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 2000))
  return result.data
}

/** Persisted files may contain extensions; never return arbitrary stored fields
 * to a model or let model input overwrite provider credentials or endpoints. */
function publicTask(task: CronTask): CronTask {
  const { id, name, description, cron, prompt, createdAt, lastFiredAt, enabled, recurring, permanent,
    permissionMode, model, providerId, folderPath, useWorktree, notification } = task
  return { id, name, description, cron, prompt, createdAt, lastFiredAt, enabled, recurring, permanent,
    permissionMode, model, providerId, folderPath, useWorktree, notification }
}

/** Caller identity comes exclusively from the active process's SDK token.
 * These actions run in the desktop host so schedules survive the child process. */
export async function executeOfficialAgentSdkHostAction(
  action: string,
  callerSessionId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  if (isSideChatId(callerSessionId) || conversationService.isTeamWorkerSession(callerSessionId)) {
    throw ApiError.conflict('Manage scheduled tasks and team cleanup from the main conversation')
  }
  if (readConversationRuntime(getClaudeConfigHomeDir(), callerSessionId) !== 'agent-sdk') {
    throw ApiError.conflict('This action requires an official Agent SDK conversation')
  }
  switch (action) {
    case 'cron-create': {
      const input = parse(createSchema, body)
      const launch = await sessionService.getSessionLaunchInfo(callerSessionId)
      const runtime = conversationService.getSessionRuntimeSelection(callerSessionId)
      const providerId = runtime ? runtime.providerId : launch?.runtimeProviderId
      const model = runtime ? runtime.modelId : launch?.runtimeModelId
      const folderPath = conversationService.getSessionWorkDir(callerSessionId) || launch?.workDir
      const provider = providerId ? await providerService.getProvider(providerId) : null
      if (!provider || provider.runtime !== 'agent-sdk' || !model || !folderPath) {
        throw ApiError.conflict('The current SDK provider, model and working directory must be available before scheduling')
      }
      const task = await cronService.createTask({ ...input, recurring: input.recurring ?? true,
        enabled: true, providerId, model, folderPath })
      return { task: publicTask(task) }
    }
    case 'cron-list':
      parse(z.strictObject({}), body)
      return { tasks: (await cronService.listTasks()).map(publicTask) }
    case 'cron-update': {
      const { taskId, ...updates } = parse(updateSchema, body)
      if (!Object.keys(updates).length) throw ApiError.badRequest('At least one scheduled task field is required')
      return { task: publicTask(await cronService.updateTask(taskId, updates)) }
    }
    case 'cron-delete': {
      const { taskId } = parse(deleteSchema, body)
      await cronService.deleteTask(taskId)
      return { ok: true }
    }
    case 'team-delete': {
      const { teamName } = parse(teamDeleteSchema, body)
      await teamService.deleteTeam(teamName, callerSessionId)
      return { ok: true }
    }
    default: throw ApiError.notFound('Unknown official Agent SDK host action')
  }
}
