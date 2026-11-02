import { expect, test } from 'bun:test'
import { readQuestions, questionAnswerInput } from '../approvalData'
import { initialQuestionFlow, changeQuestionFlow, questionFlowValues, canSubmitQuestions } from './questionFlow'

const questions = readQuestions({ questions: [
  { question: '颜色？', header: '颜色', options: [{ label: '蓝色（推荐）' }, { label: '红色' }] },
  { question: '设备？', header: '设备', multiSelect: true, options: [{ label: 'iOS' }, { label: 'Android' }] },
  { question: '说明？', options: [{ label: '默认' }, { label: '略过' }] },
] })
test('question headers survive parsing without changing submitted labels', () => {
  expect(questions[0]?.header).toBe('颜色')
  let flow = initialQuestionFlow()
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: '蓝色（推荐）' })
  flow = changeQuestionFlow(flow, questions, { type: 'open', index: 1 })
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'iOS' })
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'Android' })
  flow = changeQuestionFlow(flow, questions, { type: 'open', index: 2 })
  flow = changeQuestionFlow(flow, questions, { type: 'custom', text: ' 自定义说明 ' })
  flow = changeQuestionFlow(flow, questions, { type: 'review' })
  expect(flow.review).toBe(true)
  expect(canSubmitQuestions(flow, questions, true)).toBe(true)
  expect(canSubmitQuestions(flow, questions, false)).toBe(false)
  expect(questionAnswerInput({ metadata: { autoAnswered: true, source: 'test' } }, questionFlowValues(flow, questions))).toEqual({
    metadata: { source: 'test' }, answers: { '颜色？': '蓝色（推荐）', '设备？': 'iOS, Android', '说明？': '自定义说明' },
  })
  flow = changeQuestionFlow(flow, questions, { type: 'open', index: 1 })
  expect(flow.review).toBe(false)
  expect(flow.answers['设备？']).toEqual(['iOS', 'Android'])
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'iOS' })
  expect(questionFlowValues(flow, questions)['设备？']).toBe('Android')
})
test('empty custom text cannot resurrect previous choices or submit incomplete answers', () => {
  let flow = changeQuestionFlow(initialQuestionFlow(), questions, { type: 'choose', label: '蓝色（推荐）' })
  flow = changeQuestionFlow(flow, questions, { type: 'custom', text: '绿色' })
  flow = changeQuestionFlow(flow, questions, { type: 'custom', text: '' })
  expect(questionFlowValues(flow, questions)['颜色？']).toBe('')
  flow = changeQuestionFlow(flow, questions, { type: 'review' })
  expect(flow.review).toBe(false)
  expect(canSubmitQuestions(flow, questions, true)).toBe(false)
  flow = changeQuestionFlow(flow, questions, { type: 'custom', text: '绿色' })
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: '红色' })
  expect(flow.custom['颜色？']).toBe('')
  expect(questionFlowValues(flow, questions)['颜色？']).toBe('红色')
  expect(canSubmitQuestions(initialQuestionFlow(), [], true)).toBe(false)
})
test('invalid navigation and unknown option do not change a valid answer', () => {
  const flow = changeQuestionFlow(initialQuestionFlow(), questions, { type: 'choose', label: '红色' })
  expect(changeQuestionFlow(flow, questions, { type: 'choose', label: 'invented' })).toBe(flow)
  expect(changeQuestionFlow(flow, questions, { type: 'open', index: 99 })).toBe(flow)
})
