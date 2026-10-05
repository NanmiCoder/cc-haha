import type { TranslationKey } from '../../i18n/locales/en'
import type { TrajectoryRow, TrajectoryRowKind } from '../../types/trajectory'
import type { Tone } from '@/components/ui/Badge'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

export const KIND_LABEL_KEYS: Record<TrajectoryRowKind, TranslationKey> = {
  system: 'trajectory.kind.system',
  user: 'trajectory.kind.user',
  context: 'trajectory.kind.context',
  assistant: 'trajectory.kind.assistant',
  tool: 'trajectory.kind.tool',
  compact: 'trajectory.kind.compact',
}

/**
 * The prompt is the anchor of every turn, so it is the one kind with a colour —
 * the same blue as links. Everything else stays neutral: success / warning are
 * status colours app-wide (done / needs you), so a green context row or an amber
 * tool row read as states they are not, and terracotta is reserved for the brand
 * and selection marks. Errors are the only other colour in the table.
 */
export const KIND_TONES: Record<TrajectoryRowKind, Tone> = {
  system: 'neutral',
  user: 'info',
  context: 'neutral',
  assistant: 'neutral',
  tool: 'neutral',
  compact: 'neutral',
}

/**
 * Minimap span fill per kind — the same hue as the kind's badge, so a color
 * means one thing everywhere in the view. Lanes already separate input, model
 * and tools, so within a lane a grey step is enough; the prompt keeps its blue
 * and failures are drawn separately in error red.
 */
export const KIND_FILL_CLASSES: Record<TrajectoryRowKind, string> = {
  system: 'bg-[var(--color-text-tertiary)]',
  user: 'bg-[var(--color-info)]',
  context: 'bg-[var(--color-border-strong)]',
  assistant: 'bg-[var(--color-text-secondary)]',
  tool: 'bg-[var(--color-text-tertiary)]',
  compact: 'bg-[var(--color-text-tertiary)]',
}

/** Harness-authored rows (system prompt, compaction) are outlined to set them apart from the conversation. */
export const KIND_VARIANTS: Record<TrajectoryRowKind, 'soft' | 'outline'> = {
  system: 'outline',
  user: 'soft',
  context: 'soft',
  assistant: 'soft',
  tool: 'soft',
  compact: 'outline',
}

/** A readable name for a subagent launched by an Agent tool call. */
export function agentLabelFromInput(inputPreview: string | undefined, fallback: string): string {
  if (!inputPreview) return fallback
  for (const key of ['description', 'subagent_type', 'name']) {
    const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(inputPreview)
    if (match?.[1]) return match[1].replace(/\\"/g, '"')
  }
  return fallback
}

/** Readable names for the attachment / injection types the harness sends. */
const CONTEXT_LABEL_KEYS: Record<string, TranslationKey> = {
  skill: 'trajectory.context.skill',
  skill_listing: 'trajectory.context.skillListing',
  invoked_skills: 'trajectory.context.invokedSkills',
  dynamic_skill: 'trajectory.context.dynamicSkill',
  skill_discovery: 'trajectory.context.skillDiscovery',
  meta: 'trajectory.context.meta',
  summary: 'trajectory.context.summary',
  user_context: 'trajectory.context.userContext',
  todo_reminder: 'trajectory.context.todoReminder',
  task_reminder: 'trajectory.context.taskReminder',
  nested_memory: 'trajectory.context.memory',
  relevant_memories: 'trajectory.context.memory',
  current_session_memory: 'trajectory.context.memory',
  plan_mode: 'trajectory.context.planMode',
  plan_mode_reentry: 'trajectory.context.planMode',
  plan_mode_exit: 'trajectory.context.planMode',
  plan_file_reference: 'trajectory.context.planMode',
  auto_mode: 'trajectory.context.autoMode',
  auto_mode_exit: 'trajectory.context.autoMode',
  date_change: 'trajectory.context.dateChange',
  deferred_tools_delta: 'trajectory.context.toolsDelta',
  agent_listing_delta: 'trajectory.context.agentsDelta',
  mcp_instructions_delta: 'trajectory.context.mcpInstructions',
  mcp_resource: 'trajectory.context.mcpResource',
  critical_system_reminder: 'trajectory.context.reminder',
  diagnostics: 'trajectory.context.diagnostics',
  file: 'trajectory.context.file',
  already_read_file: 'trajectory.context.file',
  compact_file_reference: 'trajectory.context.file',
  pdf_reference: 'trajectory.context.file',
  edited_text_file: 'trajectory.context.fileChange',
  edited_image_file: 'trajectory.context.fileChange',
  directory: 'trajectory.context.file',
  selected_lines_in_ide: 'trajectory.context.ide',
  opened_file_in_ide: 'trajectory.context.ide',
  queued_command: 'trajectory.context.queued',
  task_status: 'trajectory.context.taskStatus',
  token_usage: 'trajectory.context.budget',
  budget_usd: 'trajectory.context.budget',
  output_token_usage: 'trajectory.context.budget',
  teammate_mailbox: 'trajectory.context.team',
  team_context: 'trajectory.context.team',
  api_error: 'trajectory.context.apiError',
  task_notification: 'trajectory.context.taskNotification',
  command_output: 'trajectory.context.commandOutput',
  interrupted: 'trajectory.context.interrupted',
  api_retry: 'trajectory.context.apiRetry',
  local_command: 'trajectory.context.localCommand',
  hook_summary: 'trajectory.context.hook',
  stream_retry: 'trajectory.context.streamRetry',
  informational: 'trajectory.context.informational',
  away_summary: 'trajectory.context.awaySummary',
  scheduled_task: 'trajectory.context.scheduledTask',
  deferred_tools_record: 'trajectory.context.toolsDelta',
  environment: 'trajectory.context.environment',
  instructions: 'trajectory.context.instructions',
  session_context: 'trajectory.context.sessionContext',
  permission_retry: 'trajectory.context.permissionRetry',
  memory_saved: 'trajectory.context.memorySaved',
  agents_killed: 'trajectory.context.agentsKilled',
  model_fallback: 'trajectory.context.modelFallback',
}

/** Sub label for user rows that did not come from typing a prompt. */
export function userLabel(row: TrajectoryRow, t: Translate): string | null {
  switch (row.label) {
    case 'queued': return t('trajectory.user.queued')
    case 'command': return t('trajectory.user.command')
    case 'session_message': return t('trajectory.user.sessionMessage')
    default: return null
  }
}

export function contextLabel(row: TrajectoryRow, t: Translate): string | null {
  const type = row.label ?? row.attachmentType
  if (!type) return null
  if (type.startsWith('hook_') || type === 'async_hook_response') return t('trajectory.context.hook')
  const key = CONTEXT_LABEL_KEYS[type]
  return key ? t(key) : type
}

export function systemRowTitle(row: TrajectoryRow, t: Translate): string {
  switch (row.snapshot?.change) {
    case 'system': return t('trajectory.system.updated')
    case 'tools': return t('trajectory.system.toolsUpdated')
    case 'system+tools': return t('trajectory.system.bothUpdated')
    case 'context': return t('trajectory.system.userContext')
    default: return t('trajectory.system.initial')
  }
}

export function turnLabel(turn: number | null, t: Translate): string {
  if (turn === null) return ''
  return turn === 0 ? t('trajectory.turn.before') : t('trajectory.turn.n', { n: turn })
}
