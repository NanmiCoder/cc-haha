import { afterEach, expect, test } from 'bun:test'
import { setAgentProfile } from '../../utils/agentProfile.js'
import { createUserMessage } from '../../utils/messages.js'
import type { ToolUseContext } from '../../Tool.js'
import { SkillTool } from './SkillTool.js'

afterEach(() => setAgentProfile('standard'))

test('lean Skill schema describes explicit invocation without discovery instructions', async () => {
  setAgentProfile('lean')
  const prompt = await SkillTool.prompt({} as Parameters<typeof SkillTool.prompt>[0])
  expect(prompt).toContain('explicitly selected')
  expect(prompt).not.toContain('BLOCKING REQUIREMENT')
  expect(prompt).not.toContain('Available skills are listed')
})

test('lean rejects an unrequested model skill before reading registries or MCP state', async () => {
  setAgentProfile('lean')
  const context = {
    messages: [createUserMessage({ content: 'Fix the failing test' })],
    getAppState() { throw new Error('must not discover commands') },
  } as unknown as ToolUseContext
  const result = await SkillTool.validateInput!({ skill: 'unrequested' }, context)
  expect(result.result).toBe(false)
  if (!result.result) expect(result.message).toContain('explicit user skill selection')
})
