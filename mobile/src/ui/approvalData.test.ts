import { expect, test } from 'bun:test'
import {
  planPermissionUpdates,
  questionAnswerInput,
  questionOptionPresentation,
  readQuestions,
  remainingQuestionTime,
} from './approvalData'

test('recommended option badge is display-only and leaves submitted answer labels intact', () => {
  expect(questionOptionPresentation('保留兼容（推荐）')).toEqual({
    label: '保留兼容',
    recommended: true,
  })
  expect(questionOptionPresentation('Keep fields (Recommended)')).toEqual({
    label: 'Keep fields',
    recommended: true,
  })
  expect(questionOptionPresentation('推荐策略（保留）')).toEqual({
    label: '推荐策略（保留）',
    recommended: false,
  })
  const input = {
    questions: [
      { question: '如何迁移？', options: [{ label: '保留兼容（推荐）' }] },
    ],
  }
  expect(
    questionAnswerInput(input, {
      '如何迁移？': input.questions[0]!.options[0]!.label,
    }).answers['如何迁移？']
  ).toBe('保留兼容（推荐）')
})

test('manual answers preserve exact question keys, options and unrelated metadata', () => {
  const input = {
    questions: [
      {
        question: 'Which scope?',
        multiSelect: true,
        options: [{ label: 'Local (Recommended)', description: 'Local' }],
      },
    ],
    metadata: { autoAnswered: true, source: 'desktop' },
  }
  expect(readQuestions(input)).toEqual(input.questions)
  expect(
    questionAnswerInput(input, { 'Which scope?': 'Local (Recommended)' })
  ).toMatchObject({
    answers: { 'Which scope?': 'Local (Recommended)' },
    metadata: { source: 'desktop' },
  })
  expect(input.metadata.autoAnswered).toBe(true)
})
test('plan execution mode and server-provided allowed prompts become explicit session updates', () => {
  expect(
    planPermissionUpdates('acceptEdits', {
      allowedPrompts: [
        { tool: 'Bash', prompt: ' run tests ' },
        { tool: 'Bash', prompt: '' },
        null,
      ],
    })
  ).toEqual([
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'prompt: run tests' }],
      behavior: 'allow',
      destination: 'session',
    },
  ])
  expect(planPermissionUpdates('default', {})).toEqual([
    { type: 'setMode', mode: 'default', destination: 'session' },
  ])
})
test('countdown derives only from the server deadline and never invents unknown durations', () => {
  expect(remainingQuestionTime(91_000, 30_001)).toEqual({
    seconds: 61,
    label: '1:01',
  })
  expect(remainingQuestionTime(0, 1_000)).toEqual({ seconds: 0, label: '0:00' })
  for (const value of [undefined, null, Infinity, NaN])
    expect(remainingQuestionTime(value, 0)).toBeNull()
})
