import { expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { isExplicitSkillRequest } from './explicitSkillRequest.js'

test('only explicit selection in current human prompt grants skill access', () => {
  for (const text of ['/review fix this', 'Use $review here', 'Use the Skill tool with skill: "review" for this request.']) {
    expect(isExplicitSkillRequest([createUserMessage({ content: text })], 'review')).toBe(true)
  }
  for (const text of ['review my code', '/review-other', '/tmp/review']) {
    expect(isExplicitSkillRequest([createUserMessage({ content: text })], 'review')).toBe(false)
  }
  expect(isExplicitSkillRequest([
    createUserMessage({ content: '/review' }), createUserMessage({ content: 'new request' }),
  ], 'review')).toBe(false)
  expect(isExplicitSkillRequest([
    createUserMessage({ content: 'fix this' }), createUserMessage({ content: '/review', isMeta: true }),
    createAssistantMessage({ content: [{ type: 'text', text: '/review' }] }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fixture', content: '/review' }] }),
  ], 'review')).toBe(false)
})
