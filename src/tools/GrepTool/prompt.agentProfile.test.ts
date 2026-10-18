import { afterEach, expect, test } from 'bun:test'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'
import { getDescription } from './prompt.js'

const originalProfile = getAgentProfile()
afterEach(() => setAgentProfile(originalProfile))

test('lean Grep removes only guidance to the unavailable Agent tool', () => {
  setAgentProfile('standard')
  const standard = getDescription()
  const guidance = '  - Use Agent tool for open-ended searches requiring multiple rounds\n'
  expect(standard).toContain(guidance)
  setAgentProfile('lean')
  expect(getDescription()).toBe(standard.replace(guidance, ''))
  expect(getDescription()).not.toContain('Use Agent tool')
})
