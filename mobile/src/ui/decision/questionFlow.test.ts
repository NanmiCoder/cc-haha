import { expect, test } from 'bun:test'
import { readQuestions, questionAnswerInput } from '../approvalData'
import { initialQuestionFlow, changeQuestionFlow, questionFlowValues, canSubmitQuestions } from './questionFlow'

const questions = readQuestions({ questions: [
  { question: 'Color?', header: 'Color', options: [{ label: 'Blue (recommended)' }, { label: 'Red' }] },
  { question: 'Device?', header: 'Device', multiSelect: true, options: [{ label: 'iOS' }, { label: 'Android' }] },
  { question: 'Note?', options: [{ label: 'Default' }, { label: 'Skip' }] },
] })
test('question headers survive parsing without changing submitted labels', () => {
  expect(questions[0]?.header).toBe('Color')
  let flow = initialQuestionFlow()
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'Blue (recommended)' })
  flow = changeQuestionFlow(flow, questions, { type: 'open', index: 1 })
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'iOS' })
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'Android' })
  flow = changeQuestionFlow(flow, questions, { type: 'open', index: 2 })
  flow = changeQuestionFlow(flow, questions, { type: 'custom', text: ' Custom note ' })
  flow = changeQuestionFlow(flow, questions, { type: 'review' })
  expect(flow.review).toBe(true)
  expect(canSubmitQuestions(flow, questions, true)).toBe(true)
  expect(canSubmitQuestions(flow, questions, false)).toBe(false)
  expect(questionAnswerInput({ metadata: { autoAnswered: true, source: 'test' } }, questionFlowValues(flow, questions))).toEqual({
    metadata: { source: 'test' }, answers: { 'Color?': 'Blue (recommended)', 'Device?': 'iOS, Android', 'Note?': 'Custom note' },
  })
  flow = changeQuestionFlow(flow, questions, { type: 'open', index: 1 })
  expect(flow.review).toBe(false)
  expect(flow.answers['Device?']).toEqual(['iOS', 'Android'])
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'iOS' })
  expect(questionFlowValues(flow, questions)['Device?']).toBe('Android')
})
test('empty custom text cannot resurrect previous choices or submit incomplete answers', () => {
  let flow = changeQuestionFlow(initialQuestionFlow(), questions, { type: 'choose', label: 'Blue (recommended)' })
  flow = changeQuestionFlow(flow, questions, { type: 'custom', text: 'Green' })
  flow = changeQuestionFlow(flow, questions, { type: 'custom', text: '' })
  expect(questionFlowValues(flow, questions)['Color?']).toBe('')
  flow = changeQuestionFlow(flow, questions, { type: 'review' })
  expect(flow.review).toBe(false)
  expect(canSubmitQuestions(flow, questions, true)).toBe(false)
  flow = changeQuestionFlow(flow, questions, { type: 'custom', text: 'Green' })
  flow = changeQuestionFlow(flow, questions, { type: 'choose', label: 'Red' })
  expect(flow.custom['Color?']).toBe('')
  expect(questionFlowValues(flow, questions)['Color?']).toBe('Red')
  expect(canSubmitQuestions(initialQuestionFlow(), [], true)).toBe(false)
})
test('invalid navigation and unknown option do not change a valid answer', () => {
  const flow = changeQuestionFlow(initialQuestionFlow(), questions, { type: 'choose', label: 'Red' })
  expect(changeQuestionFlow(flow, questions, { type: 'choose', label: 'invented' })).toBe(flow)
  expect(changeQuestionFlow(flow, questions, { type: 'open', index: 99 })).toBe(flow)
})
