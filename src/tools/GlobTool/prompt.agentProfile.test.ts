import { afterEach, expect, test } from 'bun:test'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'
import { GlobTool } from './GlobTool.js'
import { DESCRIPTION, getDescription } from './prompt.js'

const originalProfile = getAgentProfile()
afterEach(() => setAgentProfile(originalProfile))

test('lean Glob removes only guidance to the unavailable Agent tool', async () => {
  setAgentProfile('standard')
  expect(getDescription()).toBe(DESCRIPTION)
  expect(await GlobTool.prompt()).toBe(DESCRIPTION)
  const guidance = '\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead'
  expect(DESCRIPTION).toContain(guidance)
  setAgentProfile('lean')
  expect(await GlobTool.prompt()).toBe(DESCRIPTION.replace(guidance, ''))
  expect(await GlobTool.description()).toBe(getDescription())
})
