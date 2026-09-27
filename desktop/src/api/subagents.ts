import { api } from './client'
import type { MessageEntry } from '../types/session'
import type { AgentTaskNotification } from '../types/chat'

export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'
export type SubagentRunSource = 'subagent-jsonl' | 'session-history' | 'live-task' | 'none'

export type SubagentRunUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type SubagentRunResponse = {
  sessionId: string
  toolUseId: string
  agentId: string | null
  taskId?: string
  status: SubagentRunStatus
  description?: string
  prompt?: string
  summary?: string
  result?: string
  outputFile?: string
  usage?: SubagentRunUsage
  messages: MessageEntry[]
  /**
   * Full Activity projection, sent only when `truncated` is true — otherwise
   * `messages` already is that projection, and the server does not ship the
   * same array twice. Callers fall back to `messages`.
   */
  activityMessages?: MessageEntry[]
  /** Structured terminal events hidden from the visible transcript. */
  taskNotifications?: AgentTaskNotification[]
  /** Terminal events with the same fragment-scoped ids as activityMessages. */
  activityTaskNotifications?: AgentTaskNotification[]
  truncated: boolean
  historyComplete?: boolean
  activityComplete?: boolean
  updatedAt?: string
  source: SubagentRunSource
  /**
   * Whether a follow-up can still reach this agent. Only named teammates and
   * in-flight background agents have an inbox — a one-shot subagent answers
   * once and is done, so the page shows its record without a composer.
   * Optional so a response from an older server still parses.
   */
  canSendMessage?: boolean
}

/**
 * Marks a subagent addressed by agent id rather than by the `Agent` tool call
 * that spawned it.
 *
 * Workflow agents are spawned by the workflow runtime, so no such tool call
 * exists. Carrying the distinction in the identifier means the tab id, the
 * page, and the return path all stay exactly as they are for every other
 * subagent — only the fetch differs.
 */
export const AGENT_ID_REF_PREFIX = 'agent:'

export function isAgentIdRef(ref: string): boolean {
  if (!ref.startsWith(AGENT_ID_REF_PREFIX)) return false
  const agentId = readAgentIdRef(ref)
  return agentId.length > 0 && !agentId.includes('/')
}

export function toAgentIdRef(agentId: string): string {
  return `${AGENT_ID_REF_PREFIX}${agentId}`
}

export function readAgentIdRef(ref: string): string {
  return ref.slice(AGENT_ID_REF_PREFIX.length)
}

export const subagentsApi = {
  getRunByAgent(sessionId: string, agentId: string) {
    return api.get<SubagentRunResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents/by-agent/${encodeURIComponent(agentId)}`,
    )
  },

  getRunByTool(sessionId: string, toolUseId: string, taskId?: string) {
    const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''
    return api.get<SubagentRunResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents/by-tool/${encodeURIComponent(toolUseId)}${query}`,
    )
  },

  sendMessage(sessionId: string, toolUseId: string, content: string, taskId?: string) {
    const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''
    return api.post<{ ok: true; delivery?: 'queued' | 'resumed'; agent_id?: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents/by-tool/${encodeURIComponent(toolUseId)}/messages${query}`,
      { content },
    )
  },
}
