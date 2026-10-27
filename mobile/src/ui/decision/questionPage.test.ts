import { describe, expect, test } from 'bun:test'
import { readQuestions } from '../approvalData'
import { changeQuestionFlow, initialQuestionFlow, type QuestionAction } from './questionFlow'
import {
  backQuestionStep,
  primaryQuestionStep,
  questionPageModel,
  questionPromptLabel,
} from './questionPage'

const questions = readQuestions({
  questions: [
    { question: '颜色？', options: [{ label: '蓝色' }, { label: '红色' }] },
    { question: '检查哪些能力？', multiSelect: true, options: [{ label: 'Composer' }, { label: '目录与 Git' }, { label: '团队活动' }] },
    { question: '说明？', options: [{ label: '默认' }] },
  ],
})
const live = { ready: true, sent: false }
const apply = (...actions: QuestionAction[]) =>
  actions.reduce((flow, action) => changeQuestionFlow(flow, questions, action), initialQuestionFlow())

describe('question page model', () => {
  test('title position, progress and kind follow the current step', () => {
    const first = questionPageModel(initialQuestionFlow(), questions, live)
    expect(first).toMatchObject({ position: '1/3', kind: '第 1 题 · 单选', primaryLabel: '下一题', canBack: false })
    expect(first.progress).toBeCloseTo(1 / 3)
    const second = questionPageModel(apply({ type: 'open', index: 1 }), questions, live)
    expect(second).toMatchObject({ position: '2/3', kind: '第 2 题 · 多选', canBack: true })
    expect(second.progress).toBeCloseTo(2 / 3)
    const last = questionPageModel(apply({ type: 'open', index: 2 }), questions, live)
    expect(last).toMatchObject({ primaryLabel: '提交', last: true, progress: 1 })
  })

  test('a single question has no position and still submits from its only screen', () => {
    const one = questions.slice(0, 1)
    const model = questionPageModel(initialQuestionFlow(), one, live)
    expect(model).toMatchObject({ position: null, primaryLabel: '提交', last: true, primaryEnabled: false })
  })

  test('next stays off until the current question has an answer', () => {
    expect(questionPageModel(initialQuestionFlow(), questions, live).primaryEnabled).toBe(false)
    expect(questionPageModel(apply({ type: 'choose', label: '蓝色' }), questions, live).primaryEnabled).toBe(true)
    // A custom answer counts like a choice.
    expect(questionPageModel(apply({ type: 'custom', text: '绿色' }), questions, live).primaryEnabled).toBe(true)
    expect(questionPageModel(apply({ type: 'custom', text: '   ' }), questions, live).primaryEnabled).toBe(false)
  })

  test('submit needs every question answered, not just the last one', () => {
    const onlyLast = apply({ type: 'open', index: 2 }, { type: 'choose', label: '默认' })
    expect(questionPageModel(onlyLast, questions, live)).toMatchObject({ last: true, answered: true, primaryEnabled: false })
    const all = apply(
      { type: 'choose', label: '蓝色' },
      { type: 'open', index: 1 },
      { type: 'choose', label: 'Composer' },
      { type: 'open', index: 2 },
      { type: 'choose', label: '默认' }
    )
    expect(questionPageModel(all, questions, live).primaryEnabled).toBe(true)
  })

  test('nothing can be pressed while sending or when the computer is not ready', () => {
    const flow = apply({ type: 'choose', label: '蓝色' }, { type: 'open', index: 1 })
    expect(questionPageModel(flow, questions, { ready: false, sent: false })).toMatchObject({ primaryEnabled: false, discussEnabled: false, canBack: true })
    expect(questionPageModel(flow, questions, { ready: true, sent: true })).toMatchObject({ primaryEnabled: false, discussEnabled: false, canBack: false })
  })

  test('multi-select hint counts what is picked and a custom answer replaces the picks', () => {
    const at = (...actions: QuestionAction[]) => questionPageModel(apply({ type: 'open', index: 1 }, ...actions), questions, live)
    expect(at().hint).toBe('可以多选')
    expect(at({ type: 'choose', label: 'Composer' }, { type: 'choose', label: '目录与 Git' }).hint).toBe('可以多选，已选 2 项')
    expect(at({ type: 'choose', label: 'Composer' }, { type: 'custom', text: '别的' }).hint).toBe('可以多选，已选 1 项')
    expect(questionPageModel(initialQuestionFlow(), questions, live).hint).toBeNull()
  })

  test('an out-of-range index is clamped instead of crashing the page', () => {
    expect(questionPageModel({ ...initialQuestionFlow(), index: 9 }, questions, live).index).toBe(2)
    expect(questionPageModel(initialQuestionFlow(), [], live)).toMatchObject({ total: 0, current: undefined, primaryEnabled: false, progress: 0 })
  })
})

describe('question steps', () => {
  test('choosing never advances by itself; the primary button moves on, then submits all answers together', () => {
    let flow = apply({ type: 'choose', label: '蓝色' })
    expect(flow.index).toBe(0)
    const next = primaryQuestionStep(flow, questions, live)
    expect(next).toEqual({ type: 'open', index: 1 })
    flow = changeQuestionFlow(flow, questions, next as QuestionAction)
    flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'Composer' })
    flow = changeQuestionFlow(flow, questions, { type: 'choose', label: '团队活动' })
    flow = changeQuestionFlow(flow, questions, { type: 'open', index: 2 })
    flow = changeQuestionFlow(flow, questions, { type: 'custom', text: ' 随便 ' })
    expect(primaryQuestionStep(flow, questions, live)).toEqual({
      type: 'submit',
      answers: { '颜色？': '蓝色', '检查哪些能力？': 'Composer, 团队活动', '说明？': '随便' },
    })
    expect(primaryQuestionStep(flow, questions, { ready: false, sent: false })).toBeNull()
    expect(primaryQuestionStep(flow, questions, { ready: true, sent: true })).toBeNull()
  })

  test('back goes one question earlier and keeps what was answered', () => {
    const flow = apply({ type: 'choose', label: '红色' }, { type: 'open', index: 1 })
    const back = backQuestionStep(flow, questions, live)
    expect(back).toEqual({ type: 'open', index: 0 })
    const returned = changeQuestionFlow(flow, questions, back as QuestionAction)
    expect(questionPageModel(returned, questions, live).answered).toBe(true)
    expect(backQuestionStep(initialQuestionFlow(), questions, live)).toBeNull()
  })

  test('the prompt row says how many questions are waiting', () => {
    expect(questionPromptLabel(1)).toBe('有 1 个问题等你回答')
    expect(questionPromptLabel(3)).toBe('有 3 个问题等你回答')
  })
})
