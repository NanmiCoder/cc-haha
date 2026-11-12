import { expect, test } from 'bun:test'
import {
  decisionResponse,
  planPermissionUpdates,
  questionAnswerInput,
  questionAnswerValues,
  questionClock,
  questionOptionPresentation,
  readQuestions,
  remainingQuestionTime,
} from './approvalData'

test('recommended option badge is display-only and leaves submitted answer labels intact', () => {
  expect(questionOptionPresentation('Keep compatibility (recommended)')).toEqual({
    label: 'Keep compatibility',
    recommended: true,
  })
  expect(questionOptionPresentation('Keep fields (Recommended)')).toEqual({
    label: 'Keep fields',
    recommended: true,
  })
  expect(questionOptionPresentation('Recommended strategy (keep)')).toEqual({
    label: 'Recommended strategy (keep)',
    recommended: false,
  })
  const input = {
    questions: [
      { question: 'How to migrate?', options: [{ label: 'Keep compatibility (recommended)' }] },
    ],
  }
  expect(
    questionAnswerInput(input, {
      'How to migrate?': input.questions[0]!.options[0]!.label,
    }).answers['How to migrate?']
  ).toBe('Keep compatibility (recommended)')
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

test('custom answers override selected options and multi-select joins with comma', () => {
  const questions = readQuestions({
    questions: [
      { question: 'A', options: [{ label: 'x' }, { label: 'y' }], multiSelect: true },
      { question: 'B', options: [{ label: 'z' }] },
      { question: 'C', options: [{ label: 'w' }] },
    ],
  })
  expect(
    questionAnswerValues(
      questions,
      { A: ['x', 'y'], B: ['z'] },
      { B: '  I will say it myself  ', C: '   ' }
    )
  ).toEqual({ A: 'x, y', B: 'I will say it myself', C: '' })
})

test('AI auto-answer chip counts down, shows takeover after local activity and expiry at zero', () => {
  expect(questionClock(61_000, 1_000, false, 120)).toEqual({
    state: 'counting',
    label: '1:00',
    fraction: 0.5,
  })
  // A baseline smaller than the remaining time never overflows the ring.
  expect(questionClock(61_000, 1_000, false, 10)).toMatchObject({ fraction: 1 })
  expect(questionClock(1_000, 5_000, false)).toEqual({ state: 'expired' })
  expect(questionClock(61_000, 1_000, true)).toEqual({ state: 'takenOver' })
  expect(questionClock(null, 1_000, true)).toEqual({ state: 'takenOver' })
  // Without an announced auto answer there is no chip, interacted or not.
  expect(questionClock(undefined, 1_000, true)).toBeNull()
  expect(questionClock(null, 1_000, false)).toBeNull()
})

test('permission responses: deny carries only an optional note for every tool', () => {
  for (const toolName of ['Bash', 'Edit', 'AskUserQuestion', 'ExitPlanMode'])
    expect(
      decisionResponse({
        requestId: 'r',
        toolName,
        input: { allowedPrompts: [{ tool: 'Bash', prompt: 'x' }] },
        allowed: false,
        remember: true,
        note: '  Use the mock set  ',
        plan: { mode: 'bypassPermissions' },
      })
    ).toEqual({
      type: 'permission_response',
      requestId: 'r',
      allowed: false,
      denyMessage: 'Use the mock set',
    })
  expect(
    decisionResponse({ requestId: 'r', toolName: 'Bash', input: {}, allowed: false, note: ' ' })
  ).toEqual({ type: 'permission_response', requestId: 'r', allowed: false })
})

test('permission responses: allow keeps question, plan, remember and accept-edits semantics', () => {
  expect(
    decisionResponse({
      requestId: 'q',
      toolName: 'AskUserQuestion',
      input: { questions: [], metadata: { autoAnswered: true, k: 1 } },
      allowed: true,
      answers: { A: 'x' },
    })
  ).toEqual({
    type: 'permission_response',
    requestId: 'q',
    allowed: true,
    updatedInput: { questions: [], metadata: { k: 1 }, answers: { A: 'x' } },
  })
  const runtime = { providerId: null, modelId: 'model-b', effortLevel: 'high' }
  expect(
    decisionResponse({
      requestId: 'p',
      toolName: 'ExitPlanMode',
      input: {},
      allowed: true,
      plan: { mode: 'default', runtime },
    })
  ).toEqual({
    type: 'permission_response',
    requestId: 'p',
    allowed: true,
    permissionUpdates: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    runtimeOverride: runtime,
  })
  expect(
    decisionResponse({ requestId: 'p', toolName: 'ExitPlanMode', input: {}, allowed: true })
      .runtimeOverride
  ).toBeUndefined()
  expect(
    decisionResponse({ requestId: 'b', toolName: 'Bash', input: {}, allowed: true, remember: true })
  ).toEqual({ type: 'permission_response', requestId: 'b', allowed: true, rule: 'always' })
  // File edits use rule:'always' like commands: the computer applies the CLI suggestion, and auto mode is not downgraded to auto-accept edits.
  expect(
    decisionResponse({ requestId: 'e', toolName: 'Edit', input: {}, allowed: true, remember: true })
  ).toEqual({ type: 'permission_response', requestId: 'e', allowed: true, rule: 'always' })
  expect(
    decisionResponse({ requestId: 'e', toolName: 'Edit', input: {}, allowed: true, remember: true })
  ).not.toHaveProperty('permissionUpdates')
  expect(
    decisionResponse({ requestId: 'b', toolName: 'Bash', input: {}, allowed: true })
  ).toEqual({ type: 'permission_response', requestId: 'b', allowed: true })
})
