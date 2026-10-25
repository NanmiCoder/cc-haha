export type OfficialSdkServerNotification = {
  type: 'system_notification'
  subtype: string
  message?: string
  data: Record<string, unknown>
}

const systemSubtypes = new Set([
  'model_refusal_fallback', 'model_refusal_no_fallback', 'model_consent_fallback',
  'commands_changed', 'elicitation_complete', 'task_started', 'task_progress',
  'task_notification', 'task_updated', 'background_tasks_changed',
])

/**
 * Preserve the SDK's structured event data. In particular, do not flatten a
 * task patch into progress or a command-list replacement into an incremental
 * command update. Those operations have different replay semantics.
 */
export function toOfficialSdkServerNotification(value: unknown): OfficialSdkServerNotification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const frame = value as Record<string, unknown>
  const subtype = frame.type === 'conversation_reset' ? 'conversation_reset'
    : frame.type === 'system' && typeof frame.subtype === 'string' && systemSubtypes.has(frame.subtype)
      ? frame.subtype : undefined
  if (!subtype) return null
  if (subtype === 'conversation_reset' && typeof frame.new_conversation_id !== 'string') return null
  if (subtype === 'commands_changed' && !Array.isArray(frame.commands)) return null
  if (subtype === 'background_tasks_changed' && !Array.isArray(frame.tasks)) return null
  if (subtype.startsWith('task_') && typeof frame.task_id !== 'string') return null
  if (subtype === 'task_updated' && (!frame.patch || typeof frame.patch !== 'object' || Array.isArray(frame.patch))) return null
  const message = [frame.content, frame.message, frame.summary, frame.description, frame.title]
    .find((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return {
    type: 'system_notification', subtype,
    ...(message !== undefined ? { message } : {}),
    data: { ...frame, official_agent_sdk: true },
  }
}
