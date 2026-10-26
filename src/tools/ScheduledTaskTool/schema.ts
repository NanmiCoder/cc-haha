import { z } from 'zod/v4'

const id = z.string().trim().min(1).max(200)
const timeZone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}, 'Expected an IANA time zone')

export const scheduledTaskScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), runAt: z.iso.datetime({ offset: true }), timeZone }),
  z.strictObject({ kind: z.literal('cron'), expression: z.string().trim().min(1).max(200), timeZone }),
])
export const scheduledTaskExecutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), targetSessionId: id }),
  z.strictObject({ kind: z.literal('new-session') }),
])
export const scheduledTaskEditableSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(32_000).optional(),
  schedule: scheduledTaskScheduleSchema.optional(),
  execution: scheduledTaskExecutionSchema.optional(),
  enabled: z.boolean().optional(),
  notificationPolicy: z.enum(['important', 'all', 'failed', 'none']).optional(),
  notification: z.strictObject({ enabled: z.boolean(), channels: z.array(z.enum(['desktop', 'telegram', 'feishu'])).max(3) }).optional(),
})
const revision = z.number().int().positive().optional()

export const scheduledTaskInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), scope: z.enum(['current_session', 'all']).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().nonnegative().optional() }),
  z.strictObject({ action: z.literal('view'), id }),
  scheduledTaskEditableSchema.extend({
    action: z.literal('create'), requestId: id.optional(),
    name: z.string().trim().min(1).max(200), prompt: z.string().trim().min(1).max(32_000),
    schedule: scheduledTaskScheduleSchema,
  }),
  z.strictObject({ action: z.literal('update'), id, expectedRevision: revision, changes: scheduledTaskEditableSchema.refine(value => Object.keys(value).length > 0, 'Provide at least one change') }),
  z.strictObject({ action: z.literal('delete'), id, expectedRevision: revision }),
  z.strictObject({ action: z.literal('runs'), taskId: id.optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(8000).optional() }),
  z.strictObject({
    action: z.literal('run'), runId: id,
    outputOffset: z.number().int().nonnegative().optional(), errorOffset: z.number().int().nonnegative().optional(),
    maxChars: z.number().int().min(100).max(16_000).optional(),
  }),
  z.strictObject({ action: z.literal('report'), runId: id, decision: z.enum(['notify', 'silent']) }),
])

export type ScheduledTaskInput = z.infer<typeof scheduledTaskInputSchema>
