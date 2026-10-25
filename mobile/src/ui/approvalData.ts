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

/** 每道题的提交值：自己写的内容优先覆盖已选项，多选用 “, ” 连接。 */
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
 * AI 代答胶囊。只在服务端宣布过代答（deadline 为数字或 null）时出现；
 * 本机已发出接手信号就显示“你已接手”；倒计时以首次看到的剩余时间为满环。
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
 * 组装 permission_response。拒绝只带 denyMessage（所有工具都能附说明）；
 * 允许时按工具带答案、计划执行方式或会话规则（rule:'always'，由电脑套用 CLI 的放行建议）。
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
