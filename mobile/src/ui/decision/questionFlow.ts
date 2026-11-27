import { questionAnswerValues, type Question } from '../approvalData'

export type QuestionFlow = {
  index: number
  review: boolean
  answers: Record<string, string[]>
  custom: Record<string, string>
}
export type QuestionAction =
  | { type: 'choose'; label: string }
  | { type: 'custom'; text: string }
  | { type: 'open'; index: number }
  | { type: 'review' }
export const initialQuestionFlow = (): QuestionFlow => ({ index: 0, review: false, answers: {}, custom: {} })
export const questionFlowValues = (
  flow: QuestionFlow,
  questions: Question[],
  allowFreeText = true
) => questionAnswerValues(questions, flow.answers, flow.custom, { allowFreeText })
export function canSubmitQuestions(
  flow: QuestionFlow,
  questions: Question[],
  ready: boolean,
  allowFreeText = true
) {
  const values = questionFlowValues(flow, questions, allowFreeText)
  return ready && questions.length > 0 && questions.every((question) => Boolean(values[question.question]))
}
export function changeQuestionFlow(
  flow: QuestionFlow,
  questions: Question[],
  action: QuestionAction,
  allowFreeText = true
): QuestionFlow {
  if (action.type === 'open')
    return Number.isInteger(action.index) && action.index >= 0 && action.index < questions.length
      ? { ...flow, index: action.index, review: false } : flow
  if (action.type === 'review')
    return canSubmitQuestions(flow, questions, true, allowFreeText) ? { ...flow, review: true } : flow
  const current = questions[flow.index]
  if (!current) return flow
  const key = current.question
  if (action.type === 'custom') {
    if (!allowFreeText) return flow
    return { ...flow, custom: { ...flow.custom, [key]: action.text },
      answers: action.text.trim() ? { ...flow.answers, [key]: [] } : flow.answers }
  }
  if (!current.options.some((option) => option.label === action.label)) return flow
  const previous = flow.answers[key] ?? []
  return {
    ...flow,
    custom: { ...flow.custom, [key]: '' },
    answers: { ...flow.answers, [key]: current.multiSelect
      ? previous.includes(action.label) ? previous.filter((value) => value !== action.label) : [...previous, action.label]
      : [action.label] },
  }
}
