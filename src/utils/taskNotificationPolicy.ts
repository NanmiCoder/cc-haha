import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
  WORKFLOW_RUN_ID_TAG,
} from '../constants/xml.js'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

export const TASK_NOTIFICATION_MODEL_GUIDANCE = `Treat background task notifications as internal lifecycle updates, not new user requests. Continue any necessary work. Silently absorb duplicate or delayed results that do not change the latest verified conclusion, and intentional cleanup already established by the conversation. Do not acknowledge each notification or repeat a conclusion the user already received. Reply only when a result adds material information, changes the requested task's outcome, or requires user action; combine related results into one useful update. Investigate failures that block the requested task and report their actual impact and next steps. Do not infer intentional cleanup from exit code 143 alone.`

/** Added only to model-facing copies; transcripts and lifecycle events stay intact. */
export function addTaskNotificationModelGuidance(
  content: string | ContentBlockParam[],
): string | ContentBlockParam[] {
  const reminder = `<system-reminder>\n${TASK_NOTIFICATION_MODEL_GUIDANCE}\n</system-reminder>`
  if (typeof content === 'string') {
    return content.includes(TASK_NOTIFICATION_MODEL_GUIDANCE)
      ? content
      : `${content}\n\n${reminder}`
  }
  if (content.some(block => block.type === 'text' && block.text.includes(TASK_NOTIFICATION_MODEL_GUIDANCE))) {
    return content
  }
  return [...content, { type: 'text', text: reminder }]
}

type TaskNotificationStatus = 'completed' | 'failed' | 'stopped'

export type ParsedTaskNotification = {
  taskId: string
  toolUseId?: string
  taskType?: string
  workflowRunId?: string
  outputFile: string
  status?: TaskNotificationStatus
  summary: string
  result?: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}

function getTagValue(text: string, tag: string): string | undefined {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]
}

function normalizeStatus(rawStatus: string | undefined): TaskNotificationStatus | undefined {
  if (rawStatus === 'killed') return 'stopped'
  if (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped') {
    return rawStatus
  }
  return undefined
}

export function parseTaskNotificationXml(text: string): ParsedTaskNotification {
  const usageContent = getTagValue(text, 'usage') ?? ''
  const totalTokens = getTagValue(usageContent, 'total_tokens')
  const toolUses = getTagValue(usageContent, 'tool_uses')
  const durationMs = getTagValue(usageContent, 'duration_ms')

  return {
    taskId: getTagValue(text, TASK_ID_TAG) ?? '',
    toolUseId: getTagValue(text, TOOL_USE_ID_TAG),
    taskType: getTagValue(text, TASK_TYPE_TAG),
    workflowRunId: getTagValue(text, WORKFLOW_RUN_ID_TAG),
    outputFile: getTagValue(text, OUTPUT_FILE_TAG) ?? '',
    status: normalizeStatus(getTagValue(text, STATUS_TAG)),
    summary: getTagValue(text, SUMMARY_TAG) ?? '',
    result: getTagValue(text, 'result'),
    usage:
      totalTokens && toolUses
        ? {
            total_tokens: parseInt(totalTokens, 10),
            tool_uses: parseInt(toolUses, 10),
            duration_ms: durationMs ? parseInt(durationMs, 10) : 0,
          }
        : undefined,
  }
}

export function shouldForwardTaskNotificationToModel(
  notification: ParsedTaskNotification,
  options: { structuredOutput: boolean },
): boolean {
  if (!options.structuredOutput) return true
  if (!notification.status) return true
  return notification.taskType !== 'local_agent'
}

/**
 * Collects structured-output local-agent completions until the whole active
 * agent group settles. The CLI can then re-enter the model once with every
 * result instead of once per agent (duplicate replies) or never (stalled
 * coordinator turns).
 */
export class TaskNotificationFollowUpBatch {
  private notifications: string[] = []

  defer(notificationText: string): void {
    if (notificationText.length > 0) {
      this.notifications.push(notificationText)
    }
  }

  hasPending(): boolean {
    return this.notifications.length > 0
  }

  takeIfSettled(hasRunningBackgroundTasks: boolean): string | undefined {
    if (hasRunningBackgroundTasks || this.notifications.length === 0) {
      return undefined
    }
    const followUp = this.notifications.join('\n')
    this.notifications = []
    return followUp
  }
}
