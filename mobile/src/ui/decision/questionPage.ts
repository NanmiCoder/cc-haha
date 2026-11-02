import type { Question } from '../approvalData'
import {
  canSubmitQuestions,
  questionFlowValues,
  type QuestionAction,
  type QuestionFlow,
} from './questionFlow'

/** 分步页每一屏需要的派生状态：标题、进度、提示、按钮文案与可用性。 */
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
    /** “2/3”；只有一道题时不显示进度。 */
    position: total > 1 ? `${index + 1}/${total}` : null,
    /** 线性进度条的填充比例：第几题 / 总题数。 */
    progress: total ? (index + 1) / total : 0,
    kind: `第 ${index + 1} 题 · ${multiple ? '多选' : '单选'}`,
    hint: multiple ? (picked ? `可以多选，已选 ${picked} 项` : '可以多选') : null,
    canBack: index > 0 && !state.sent,
    primaryLabel: last ? '提交' : '下一题',
    primaryEnabled: !state.sent && state.ready && answered && (!last || complete),
    discussEnabled: state.ready && !state.sent,
  }
}

/** 主按钮：不是最后一题就翻到下一题，最后一题提交；不可用时返回 null。 */
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

/** “上一题”对应的流程动作；第一题没有。 */
export function backQuestionStep(
  flow: QuestionFlow,
  questions: Question[],
  state: { ready: boolean; sent: boolean }
): QuestionAction | null {
  const model = questionPageModel(flow, questions, state)
  return model.canBack ? { type: 'open', index: model.index - 1 } : null
}

/** 输入框位置那一行入口的文案。 */
export function questionPromptLabel(count: number) {
  return `有 ${count} 个问题等你回答`
}
