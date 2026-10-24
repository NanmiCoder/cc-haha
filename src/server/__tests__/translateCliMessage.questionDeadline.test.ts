import { describe, expect, test } from 'bun:test'
import { translateCliMessage } from '../ws/handler.js'

describe('question deadline wire updates', () => {
  const event = (deadline?: unknown) => ({ type: 'control_request', request_id: 'question-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Scope?', options: [{ label: 'Local' }] }] }, ...(deadline === undefined ? {} : { auto_answer_deadline: deadline }) } })
  test('forwards server timestamps and explicit cancellation; old events stay unknown', () => {
    expect(translateCliMessage(event(1_800_000_000_000), 'deadline-session')[0]).toMatchObject({ type: 'permission_request', requestId: 'question-1', autoAnswerDeadline: 1_800_000_000_000 })
    expect(translateCliMessage(event(null), 'deadline-session')[0]).toMatchObject({ type: 'permission_request', autoAnswerDeadline: null })
    for (const value of [undefined, 'soon', Infinity, NaN]) expect(translateCliMessage(event(value), 'deadline-session')[0]).not.toHaveProperty('autoAnswerDeadline')
  })
})
