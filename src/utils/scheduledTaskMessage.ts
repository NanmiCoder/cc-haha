import { z } from 'zod/v4'

export const scheduledTaskMetadataSchema = z.strictObject({
  taskId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  scheduledFor: z.string().datetime({ offset: true }),
  taskName: z.string().min(1).max(500),
})
export type ScheduledTaskMetadata = z.infer<typeof scheduledTaskMetadataSchema>

export const scheduledTaskMessageInputSchema = z.strictObject({
  subtype: z.literal('enqueue_scheduled_task'),
  message_id: z.string().min(1).max(200),
  // A validated 32k saved prompt can expand up to 6x when JSON-escaped.
  text: z.string().min(1).max(256_000),
  scheduled_task: scheduledTaskMetadataSchema,
  start_if_idle: z.boolean().optional(),
})

/** Read trusted transcript/SDK metadata, never infer provenance from prompt text. */
export function readScheduledTaskMetadata(value: unknown): ScheduledTaskMetadata | undefined {
  const parsed = scheduledTaskMetadataSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const PREFIX = 'Scheduled task invocation (host context):\n'

export function formatScheduledTaskPrompt(prompt: string, runId: string, important: boolean): string {
  return PREFIX + JSON.stringify({
    prompt,
    instructions: important
      ? `Continue the saved task in this conversation. At the end, call ScheduledTask action report with runId ${runId} and decision notify only for completion, failure, meaningful changes, or required user action; use silent for unchanged or non-actionable polling. Then provide the normal task response. Do not treat this invocation itself as a reason to notify.`
      : 'Continue the saved task in this conversation and provide the normal task response.',
  })
}

/** Called only after validating a host-stamped scheduledTask field. */
export function scheduledTaskDisplayText(content: unknown): unknown {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return content
  try {
    const data = JSON.parse(text.slice(PREFIX.length))
    return typeof data?.prompt === 'string' ? data.prompt : content
  } catch { return content }
}
