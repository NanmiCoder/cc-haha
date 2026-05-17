import type {
  BetaMessage,
  BetaContentBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { QuerySource } from '../constants/querySource.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { extractTextContent } from '../utils/messages.js'
import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js'
import { getSmallFastModel } from '../utils/model/model.js'
import { safeParseJSON } from '../utils/json.js'
import { sideQuery } from '../utils/sideQuery.js'
import {
  accountThreadGoalUsage,
  buildGoalContinuationPrompt,
  getThreadGoal,
  hydrateThreadGoalFromMessages,
  incrementThreadGoalContinuation,
  markThreadGoalComplete,
  updateThreadGoalStatus,
  type ThreadGoal,
} from './goalState.js'

export type GoalEvaluation = {
  complete: boolean
  reason: string
}

export type GoalTurnDecision =
  | { action: 'none' }
  | { action: 'continue'; goal: ThreadGoal; prompt: string; reason: string }
  | { action: 'complete'; goal: ThreadGoal; reason: string }
  | { action: 'budget_limited'; goal: ThreadGoal }

type EvaluateFn = (input: {
  goal: ThreadGoal
  transcript: string
  signal: AbortSignal
  querySource?: QuerySource
}) => Promise<GoalEvaluation>

const DEFAULT_MAX_CONTINUATIONS = 500
const DEFAULT_EVALUATOR_TIMEOUT_MS = 45_000

export async function evaluateThreadGoalAfterTurn(input: {
  threadId: string
  messages: Message[]
  assistantMessages: AssistantMessage[]
  signal: AbortSignal
  now?: number
  querySource?: QuerySource
  evaluate?: EvaluateFn
}): Promise<GoalTurnDecision> {
  const now = input.now ?? Date.now()
  const current =
    getThreadGoal(input.threadId) ??
    hydrateThreadGoalFromMessages(input.threadId, input.messages, now)
  if (!current || current.status !== 'active') return { action: 'none' }

  const tokens = input.assistantMessages.reduce(
    (sum, msg) =>
      sum +
      (msg.message.usage?.input_tokens ?? 0) +
      (msg.message.usage?.output_tokens ?? 0),
    0,
  )
  const accounted = accountThreadGoalUsage(input.threadId, tokens, now) ?? current

  if (
    accounted.tokenBudget !== null &&
    accounted.tokensUsed >= accounted.tokenBudget
  ) {
    const limited =
      updateThreadGoalStatus(input.threadId, 'budget_limited', now) ?? accounted
    return { action: 'budget_limited', goal: limited }
  }

  if (accounted.continuationCount >= getMaxContinuations()) {
    const limited =
      updateThreadGoalStatus(input.threadId, 'budget_limited', now) ?? accounted
    return { action: 'budget_limited', goal: limited }
  }

  const taskState = summarizeTaskState([
    ...input.messages,
    ...input.assistantMessages,
  ])
  if (taskState.incomplete.length > 0) {
    const reason = formatIncompleteTaskReason(taskState.incomplete)
    const continued =
      incrementThreadGoalContinuation(input.threadId, {
        reason,
        now,
      }) ?? accounted
    return {
      action: 'continue',
      goal: continued,
      reason,
      prompt: buildGoalContinuationPrompt(continued, reason),
    }
  }

  const localCompletionReason = inferCompletionFromTaskEvidence(
    [...input.messages, ...input.assistantMessages],
    taskState,
  )
  if (localCompletionReason) {
    const completed =
      markThreadGoalComplete(input.threadId, {
        reason: localCompletionReason,
        now,
      }) ?? accounted
    return {
      action: 'complete',
      goal: completed,
      reason: localCompletionReason,
    }
  }

  const transcript = formatTranscript([
    ...input.messages,
    ...input.assistantMessages,
  ])
  const evaluator = input.evaluate ?? evaluateGoalCompletion
  const evaluation = await evaluateWithTimeout(evaluator, {
    goal: accounted,
    transcript,
    signal: input.signal,
    querySource: input.querySource,
  })

  if (evaluation.complete) {
    const completed =
      markThreadGoalComplete(input.threadId, {
        reason: evaluation.reason,
        now,
      }) ?? accounted
    return {
      action: 'complete',
      goal: completed,
      reason: evaluation.reason,
    }
  }

  const continued =
    incrementThreadGoalContinuation(input.threadId, {
      reason: evaluation.reason,
      now,
    }) ?? accounted
  return {
    action: 'continue',
    goal: continued,
    reason: evaluation.reason,
    prompt: buildGoalContinuationPrompt(continued, evaluation.reason),
  }
}

async function evaluateGoalCompletion(input: {
  goal: ThreadGoal
  transcript: string
  signal: AbortSignal
  querySource?: QuerySource
}): Promise<GoalEvaluation> {
  const baseRequest = {
    querySource: input.querySource ?? 'hook_prompt',
    model: getSmallFastModel(),
    skipSystemPromptPrefix: true,
    thinking: false,
    temperature: 0,
    max_tokens: 512,
    signal: input.signal,
    system:
      'You evaluate whether a coding-agent goal is complete. ' +
      'Return JSON only. Say complete=true only when the transcript contains concrete visible evidence that the objective is satisfied.',
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: [
              `<objective>${input.goal.objective}</objective>`,
              '',
              '<transcript>',
              input.transcript,
              '</transcript>',
            ].join('\n'),
          },
        ],
      },
    ],
  }

  try {
    const response = await sideQuery({
      ...baseRequest,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            complete: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['complete', 'reason'],
          additionalProperties: false,
        },
      },
    })

    return parseEvaluationResponse(response)
  } catch (error) {
    if (input.signal.aborted) throw error
  }

  const response = await sideQuery({
    ...baseRequest,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `<objective>${input.goal.objective}</objective>`,
              '',
              '<transcript>',
              input.transcript,
              '</transcript>',
              '',
              'Return exactly one JSON object with this shape and no markdown:',
              '{"complete": false, "reason": "short evidence-based reason"}',
            ].join('\n'),
          },
        ],
      },
    ],
  })

  return parseEvaluationResponse(response)
}

function parseEvaluationResponse(response: BetaMessage): GoalEvaluation {
  const text = extractTextContent(response.content, '').trim()
  const parsed = safeParseJSON(text) ?? safeParseJSON(extractJsonObject(text))
  if (
    parsed &&
    typeof parsed === 'object' &&
    'complete' in parsed &&
    typeof parsed.complete === 'boolean'
  ) {
    return {
      complete: parsed.complete,
      reason:
        'reason' in parsed && typeof parsed.reason === 'string'
          ? parsed.reason
          : '',
    }
  }
  return {
    complete: false,
    reason: 'The evaluator did not return a valid completion decision.',
  }
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return text
  return text.slice(start, end + 1)
}

function formatTranscript(messages: Message[]): string {
  const lines: string[] = []
  const recent = messages.slice(-40)
  for (const message of recent) {
    if (message.type === 'user') {
      if (message.isMeta) continue
      lines.push(`User: ${contentToText(message.message.content)}`)
    } else if (message.type === 'assistant') {
      lines.push(`Assistant: ${assistantVisibleText(message.message.content)}`)
    } else if (message.type === 'system' && typeof message.content === 'string') {
      lines.push(`System: ${message.content}`)
    }
  }
  return lines.join('\n\n').slice(-24_000)
}

function contentToText(content: string | readonly BetaContentBlock[]): string {
  if (typeof content === 'string') return content
  return extractTextContent(content, '\n')
}

function assistantVisibleText(content: readonly BetaContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

type TaskSummary = {
  id: string
  subject: string | null
  status: string
}

function summarizeTaskState(messages: Message[]): {
  tasks: TaskSummary[]
  incomplete: TaskSummary[]
} {
  const tasks = new Map<string, TaskSummary>()

  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        if (block.name !== 'TaskUpdate') continue
        const input = block.input
        if (!input || typeof input !== 'object') continue
        const taskId = (input as { taskId?: unknown }).taskId
        const status = (input as { status?: unknown }).status
        if (typeof taskId !== 'string' || typeof status !== 'string') continue
        const existing = tasks.get(taskId)
        tasks.set(taskId, {
          id: taskId,
          subject: existing?.subject ?? null,
          status,
        })
      }
      continue
    }

    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const text = toolResultText(block.content)
      const created = text.match(/Task #(\S+) created successfully:\s*(.+)/)
      if (!created) continue
      const [, id, subject] = created
      const existing = tasks.get(id)
      tasks.set(id, {
        id,
        subject: subject.trim(),
        status: existing?.status ?? 'pending',
      })
    }
  }

  const allTasks = [...tasks.values()]
  return {
    tasks: allTasks,
    incomplete: allTasks.filter(task =>
      task.status === 'pending' || task.status === 'in_progress',
    ),
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(item =>
      item &&
      typeof item === 'object' &&
      'text' in item &&
      typeof item.text === 'string'
        ? item.text
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

function formatIncompleteTaskReason(tasks: TaskSummary[]): string {
  const taskList = tasks
    .slice(0, 3)
    .map(task => {
      const label = task.subject ? `Task #${task.id} (${task.subject})` : `Task #${task.id}`
      return `${label} is ${task.status}`
    })
    .join('; ')
  const suffix = tasks.length > 3 ? `; ${tasks.length - 3} more task(s) are incomplete` : ''
  return `The task list is not complete yet: ${taskList}${suffix}.`
}

function getMaxContinuations(): number {
  const raw = process.env.CLAUDE_CODE_GOAL_MAX_CONTINUES
  if (!raw) return DEFAULT_MAX_CONTINUATIONS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_CONTINUATIONS
}

async function evaluateWithTimeout(
  evaluator: EvaluateFn,
  input: {
    goal: ThreadGoal
    transcript: string
    signal: AbortSignal
    querySource?: QuerySource
  },
): Promise<GoalEvaluation> {
  const timeoutMs = getEvaluatorTimeoutMs()
  const { signal, cleanup } = createCombinedAbortSignal(input.signal, {
    timeoutMs,
  })
  try {
    return await evaluator({
      ...input,
      signal,
    })
  } catch (error) {
    if (input.signal.aborted) throw error
    if (signal.aborted) {
      return {
        complete: false,
        reason: `The goal completion evaluator timed out after ${Math.round(
          timeoutMs / 1000,
        )}s.`,
      }
    }
    throw error
  } finally {
    cleanup()
  }
}

function getEvaluatorTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_GOAL_EVALUATOR_TIMEOUT_MS
  if (!raw) return DEFAULT_EVALUATOR_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EVALUATOR_TIMEOUT_MS
}

function inferCompletionFromTaskEvidence(
  messages: Message[],
  taskState: { tasks: TaskSummary[]; incomplete: TaskSummary[] },
): string | null {
  if (taskState.tasks.length === 0 || taskState.incomplete.length > 0) {
    return null
  }

  const text = latestAssistantVisibleText(messages)
  if (!text) return null
  if (looksLikeFailureOrIncomplete(text)) return null
  if (!looksLikeCompletionSummary(text)) return null

  return `All ${taskState.tasks.length} tracked task(s) are complete and the final assistant response reports completion.`
}

function latestAssistantVisibleText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== 'assistant') continue
    const text = assistantVisibleText(message.message.content).trim()
    if (text) return text
  }
  return ''
}

function looksLikeCompletionSummary(text: string): boolean {
  return (
    /完成总结|目标已完成|已成功|全部验[证證]通过|均通过|构建成功|检查结果|代码审查结果/.test(
      text,
    ) ||
    /\b(completion summary|completed|complete|successfully|all tests passed|build passed|review complete|ready)\b/i.test(
      text,
    )
  )
}

function looksLikeFailureOrIncomplete(text: string): boolean {
  return (
    /未完成|尚未完成|没有完成|失败|未通过|阻塞|(?:存在|有|出现|发现).{0,6}错误/.test(
      text,
    ) ||
    /\b(incomplete|not complete|not completed|not all tests passed|tests? did not pass|failed|failing|failure|blocked|errors? found|has errors?)\b/i.test(
      text,
    )
  )
}
