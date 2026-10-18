import { afterEach, expect, test } from 'bun:test'
import { setAgentProfile } from '../../utils/agentProfile.js'
import { getSimplePrompt } from './prompt.js'

const userType = process.env.USER_TYPE
afterEach(() => {
  setAgentProfile('standard')
  if (userType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = userType
})

test('lean Bash instructions do not recommend unavailable slash skills', () => {
  process.env.USER_TYPE = 'ant'
  setAgentProfile('standard')
  const before = getSimplePrompt()
  expect(before).toContain('/commit-push-pr')
  setAgentProfile('lean')
  const lean = getSimplePrompt()
  expect(lean).not.toContain('/commit-push-pr')
  expect(lean).toContain('NEVER skip hooks')
  expect(lean).toContain('quote file paths')
  setAgentProfile('standard')
  expect(getSimplePrompt()).toBe(before)
})
