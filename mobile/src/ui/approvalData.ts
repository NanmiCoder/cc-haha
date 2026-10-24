export type Question = {
  question: string
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
