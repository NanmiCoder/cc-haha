import type { Question } from '../approvalData'
import {
  canSubmitQuestions,
  questionFlowValues,
  type QuestionAction,
  type QuestionFlow,
} from './questionFlow'
import { plural } from '../../core/plural'

/** Derived state each step page screen needs: title, progress, hint, button text and availability. */
export function questionPageModel(
  flow: QuestionFlow,
  questions: Question[],
  state: { ready: boolean; sent: boolean }
) {
  const total = questions.length
  const index = Math.min(Math.max(0, flow.index), Math.max(0, total - 1))
  const current = questions[index]
  const values = questionFlowValues(flow, questions)
  const answered = Boolean(current && values[current.question])
  const last = index >= total - 1
  const customActive = Boolean(current && flow.custom[current.question]?.trim())
  const picked = !current ? 0 : customActive ? 1 : (flow.answers[current.question]?.length ?? 0)
  const multiple = Boolean(current?.multiSelect)
  const complete = canSubmitQuestions(flow, questions, state.ready)
  return {
    index,
    total,
    current,
    last,
    multiple,
    answered,
    customActive,
    /** "2/3"; progress hidden when there is only one question. */
    position: total > 1 ? `${index + 1}/${total}` : null,
    /** Fill ratio of the linear progress bar: current question / total questions. */
    progress: total ? (index + 1) / total : 0,
    kind: `Question ${index + 1} · ${multiple ? 'multiple choice' : 'single choice'}`,
    hint: multiple ? (picked ? `Multiple choice, ${picked} selected` : 'Multiple choice') : null,
    canBack: index > 0 && !state.sent,
    primaryLabel: last ? 'Submit' : 'Next question',
    primaryEnabled: !state.sent && state.ready && answered && (!last || complete),
    discussEnabled: state.ready && !state.sent,
  }
}

/** Primary button: go to the next question unless on the last, which submits; returns null when unavailable. */
export function primaryQuestionStep(
  flow: QuestionFlow,
  questions: Question[],
  state: { ready: boolean; sent: boolean }
): { type: 'open'; index: number } | { type: 'submit'; answers: Record<string, string> } | null {
  const model = questionPageModel(flow, questions, state)
  if (!model.primaryEnabled) return null
  return model.last
    ? { type: 'submit', answers: questionFlowValues(flow, questions) }
    : { type: 'open', index: model.index + 1 }
}

/** Flow action for "Previous"; none on the first question. */
export function backQuestionStep(
  flow: QuestionFlow,
  questions: Question[],
  state: { ready: boolean; sent: boolean }
): QuestionAction | null {
  const model = questionPageModel(flow, questions, state)
  return model.canBack ? { type: 'open', index: model.index - 1 } : null
}

/** Text of the one-line entry at the input position. */
export function questionPromptLabel(count: number) {
  return `${plural(count, 'question')} waiting for your answer`
}
