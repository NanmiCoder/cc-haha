import type { RuntimeConfig } from '../core/types'

export type Question = {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
}
/** Presentation only: selection and submitted answers retain the exact server label. */
export function questionOptionPresentation(label: string) {
  const suffix = /\s*[（(](?:推荐|recommended)[）)]\s*$/i
  return { label: label.replace(suffix, ''), recommended: suffix.test(label) }
}
export function readQuestions(input: Record<string, unknown>): Question[] {
  const candidates = Array.isArray(input.questions) ? input.questions : [input]
  return candidates.flatMap((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.question !== 'string' ||
      !value.question.trim()
    )
      return []
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option: unknown) => {
          if (
            !option ||
            typeof option !== 'object' ||
            !('label' in option) ||
            typeof option.label !== 'string'
          )
            return []
          return [
            {
              label: option.label,
              ...('description' in option &&
              typeof option.description === 'string'
                ? { description: option.description }
                : {}),
            },
          ]
        })
      : []
    return [
      {
        question: value.question,
        ...(typeof value.header === 'string' && value.header.trim() ? { header: value.header } : {}),
        options,
        multiSelect: value.multiSelect === true,
      },
    ]
  })
}

export function questionAnswerInput(
  input: Record<string, unknown>,
  answers: Record<string, string>
) {
  const metadata =
    input.metadata && typeof input.metadata === 'object'
      ? { ...(input.metadata as Record<string, unknown>) }
      : undefined
  if (metadata) delete metadata.autoAnswered
  return { ...input, ...(metadata ? { metadata } : {}), answers }
}
export type PlanExecutionMode = 'default' | 'acceptEdits' | 'bypassPermissions'
export function planPermissionUpdates(
  mode: PlanExecutionMode,
  input: Record<string, unknown>
) {
  const rules = Array.isArray(input.allowedPrompts)
    ? input.allowedPrompts.flatMap((value) => {
        if (
          !value ||
          typeof value !== 'object' ||
          typeof value.tool !== 'string' ||
          typeof value.prompt !== 'string' ||
          !value.prompt.trim()
        )
          return []
        return [
          {
            toolName: value.tool,
            ruleContent: `prompt: ${value.prompt.trim()}`,
          },
        ]
      })
    : []
  return [
    { type: 'setMode', mode, destination: 'session' },
    ...(rules.length
      ? [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }]
      : []),
  ]
}
export function remainingQuestionTime(
  deadline: number | null | undefined,
  now: number
) {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return null
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000))
  return {
    seconds,
    label: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
  }
}

/** Submit value of each question: user-written content overrides selected options, and multi-select joins with ", ". */
export function questionAnswerValues(
  questions: Question[],
  answers: Record<string, string[]>,
  custom: Record<string, string>
) {
  return Object.fromEntries(
    questions.map((question) => [
      question.question,
      custom[question.question]?.trim() ||
        answers[question.question]?.join(', ') ||
        '',
    ])
  )
}

export type QuestionClock =
  | { state: 'counting'; label: string; fraction: number }
  | { state: 'takenOver' }
  | { state: 'expired' }

/**
 * AI Auto-answer capsule. Only appears when the server has announced auto-answer (deadline is a number or null); 
 * once this device has sent the take-over signal show "You took over"; the countdown uses the first seen remaining time as a full ring.
 */
export function questionClock(
  deadline: number | null | undefined,
  now: number,
  interacted: boolean,
  baselineSeconds?: number
): QuestionClock | null {
  if (interacted && deadline !== undefined) return { state: 'takenOver' }
  const remaining = remainingQuestionTime(deadline, now)
  if (!remaining) return null
  if (!remaining.seconds) return { state: 'expired' }
  const total = Math.max(baselineSeconds ?? remaining.seconds, remaining.seconds)
  return {
    state: 'counting',
    label: remaining.label,
    fraction: total ? remaining.seconds / total : 1,
  }
}

export type DecisionResponse = {
  type: 'permission_response'
  requestId: string
  allowed: boolean
  rule?: 'always'
  updatedInput?: Record<string, unknown>
  denyMessage?: string
  permissionUpdates?: unknown[]
  runtimeOverride?: RuntimeConfig
}

/**
 * Build permission_response. Deny only carries denyMessage (any tool can attach a note); 
 * allow carries the answer, plan execution mode or session rule per tool (rule:'always', where the computer applies the CLI allow suggestion).
 */
export function decisionResponse(options: {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  allowed: boolean
  answers?: Record<string, string>
  plan?: { mode: PlanExecutionMode; runtime?: RuntimeConfig }
  remember?: boolean
  note?: string
}): DecisionResponse {
  const { requestId, toolName, input, allowed } = options
  const note = options.note?.trim()
  if (!allowed)
    return {
      type: 'permission_response',
      requestId,
      allowed,
      ...(note ? { denyMessage: note } : {}),
    }
  if (toolName === 'AskUserQuestion')
    return {
      type: 'permission_response',
      requestId,
      allowed,
      updatedInput: questionAnswerInput(input, options.answers ?? {}),
    }
  if (toolName === 'ExitPlanMode')
    return {
      type: 'permission_response',
      requestId,
      allowed,
      permissionUpdates: planPermissionUpdates(
        options.plan?.mode ?? 'acceptEdits',
        input
      ),
      ...(options.plan?.runtime
        ? { runtimeOverride: options.plan.runtime }
        : {}),
    }
  return {
    type: 'permission_response',
    requestId,
    allowed,
    ...(options.remember ? { rule: 'always' as const } : {}),
  }
}
