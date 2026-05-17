import { randomUUID } from 'crypto'
import {
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../constants/xml.js'
import type { Message } from '../types/message.js'

export type ThreadGoalStatus = 'active' | 'paused' | 'complete' | 'budget_limited'

export type ThreadGoal = {
  goalId: string
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  continuationCount: number
  lastReason: string | null
  createdAt: number
  updatedAt: number
}

export type ParsedGoalCommand =
  | { type: 'clear' }
  | { type: 'set'; objective: string }

const goalsByThread = new Map<string, ThreadGoal>()
const RESERVED_GOAL_ARGS = new Set(['status', 'pause', 'resume', 'complete'])

export function parseGoalCommand(args: string): ParsedGoalCommand {
  const trimmed = args.trim()
  if (!trimmed) throw new Error('Usage: /goal <condition> | clear')
  if (trimmed === 'clear') return { type: 'clear' }
  if (RESERVED_GOAL_ARGS.has(trimmed) || trimmed.startsWith('--tokens')) {
    throw new Error('Usage: /goal <condition> | clear')
  }
  return { type: 'set', objective: trimmed }
}

export function setThreadGoal(
  threadId: string,
  input: {
    objective: string
    tokenBudget?: number | null
    now?: number
  },
): ThreadGoal {
  const now = input.now ?? Date.now()
  const goal: ThreadGoal = {
    goalId: randomUUID(),
    threadId,
    objective: input.objective.trim(),
    status: 'active',
    tokenBudget: input.tokenBudget ?? null,
    tokensUsed: 0,
    continuationCount: 0,
    lastReason: null,
    createdAt: now,
    updatedAt: now,
  }
  goalsByThread.set(threadId, goal)
  return goal
}

export function getThreadGoal(threadId: string): ThreadGoal | null {
  return goalsByThread.get(threadId) ?? null
}

export function hydrateThreadGoalFromMessages(
  threadId: string,
  messages: Message[],
  now = Date.now(),
): ThreadGoal | null {
  if (goalsByThread.has(threadId)) return goalsByThread.get(threadId) ?? null

  let pendingGoalCommand = false
  let restored: ThreadGoal | null = null

  for (const message of messages) {
    const text = messageToText(message)
    if (!text) continue

    const commandName = readXmlTag(text, COMMAND_NAME_TAG)
    if (commandName) {
      pendingGoalCommand = commandName.replace(/^\//, '') === 'goal'
      continue
    }

    const output = readXmlTag(text, LOCAL_COMMAND_STDOUT_TAG)
    if (!output) continue
    if (!pendingGoalCommand && !looksLikeGoalStatusOutput(output)) continue

    restored = goalFromLocalCommandOutput(threadId, output, restored, now)
    pendingGoalCommand = false
  }

  if (restored) goalsByThread.set(threadId, restored)
  return restored
}

export function clearThreadGoal(threadId: string): boolean {
  return goalsByThread.delete(threadId)
}

export function updateThreadGoalStatus(
  threadId: string,
  status: ThreadGoalStatus,
  now = Date.now(),
): ThreadGoal | null {
  const goal = goalsByThread.get(threadId)
  if (!goal) return null
  const updated = { ...goal, status, updatedAt: now }
  goalsByThread.set(threadId, updated)
  return updated
}

export function markThreadGoalComplete(
  threadId: string,
  input: { reason?: string; now?: number } = {},
): ThreadGoal | null {
  const goal = goalsByThread.get(threadId)
  if (!goal) return null
  const updated = {
    ...goal,
    status: 'complete' as const,
    lastReason: input.reason ?? goal.lastReason,
    updatedAt: input.now ?? Date.now(),
  }
  goalsByThread.set(threadId, updated)
  return updated
}

export function accountThreadGoalUsage(
  threadId: string,
  tokens: number,
  now = Date.now(),
): ThreadGoal | null {
  const goal = goalsByThread.get(threadId)
  if (!goal || tokens <= 0) return goal ?? null
  const updated = {
    ...goal,
    tokensUsed: goal.tokensUsed + tokens,
    updatedAt: now,
  }
  goalsByThread.set(threadId, updated)
  return updated
}

export function incrementThreadGoalContinuation(
  threadId: string,
  input: { reason?: string; now?: number } = {},
): ThreadGoal | null {
  const goal = goalsByThread.get(threadId)
  if (!goal) return null
  const updated = {
    ...goal,
    continuationCount: goal.continuationCount + 1,
    lastReason: input.reason ?? goal.lastReason,
    updatedAt: input.now ?? Date.now(),
  }
  goalsByThread.set(threadId, updated)
  return updated
}

export function formatGoalStatus(goal: ThreadGoal | null, now = Date.now()): string {
  if (!goal) return 'No active goal.'
  return [
    `Goal: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Budget: ${goal.tokensUsed.toLocaleString()} / ${
      goal.tokenBudget === null ? 'unlimited' : goal.tokenBudget.toLocaleString()
    } tokens`,
    `Elapsed: ${formatElapsed(Math.max(0, now - goal.createdAt))}`,
    `Continuations: ${goal.continuationCount.toLocaleString()}`,
    goal.lastReason ? `Latest reason: ${goal.lastReason}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

export function buildGoalStartPrompt(goal: ThreadGoal): string {
  return [
    'You are now pursuing this /goal until the completion condition is met.',
    '',
    `<objective>${goal.objective}</objective>`,
    '',
    'Work autonomously. Research, implement, test, and review as needed.',
    'Before claiming completion, perform a concrete completion audit against the objective.',
  ].join('\n')
}

export function buildGoalContinuationPrompt(
  goal: ThreadGoal,
  reason: string,
): string {
  return [
    'Continue working toward the active /goal.',
    '',
    `<objective>${goal.objective}</objective>`,
    '',
    'The goal evaluator says the objective is not complete yet.',
    `Reason: ${reason || 'No reason provided.'}`,
    '',
    'Resume directly from the current state. Do not ask the user to continue. Do the next concrete step, then test or review before stopping.',
  ].join('\n')
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function goalFromLocalCommandOutput(
  threadId: string,
  output: string,
  current: ThreadGoal | null,
  now: number,
): ThreadGoal | null {
  const trimmed = output.trim()
  if (trimmed === 'Goal cleared.' || trimmed.startsWith('Goal cleared:')) {
    return null
  }
  if (trimmed === 'No active goal.') return current
  if (trimmed === 'Goal marked complete.') {
    return current ? { ...current, status: 'complete', updatedAt: now } : null
  }
  if (trimmed.startsWith('Goal set:')) {
    const objective = trimmed.slice('Goal set:'.length).trim()
    if (!objective) return current
    return {
      goalId: randomUUID(),
      threadId,
      objective,
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      continuationCount: 0,
      lastReason: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  return current
}

function messageToText(message: Message): string {
  if (message.type === 'system') {
    return typeof message.content === 'string' ? message.content : ''
  }
  if (!('message' in message)) return ''
  const content = message.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function readXmlTag(text: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, 'i'))
  return match?.[1]?.trim() ?? null
}

function looksLikeGoalStatusOutput(output: string): boolean {
  const trimmed = output.trim()
  return (
    trimmed.startsWith('Goal set:') ||
    trimmed === 'Goal cleared.' ||
    trimmed.startsWith('Goal cleared:') ||
    trimmed === 'Goal marked complete.' ||
    trimmed === 'No active goal.'
  )
}
