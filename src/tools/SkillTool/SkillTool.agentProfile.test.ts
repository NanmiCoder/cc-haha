import { afterEach, expect, test } from 'bun:test'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { setAgentProfile } from '../../utils/agentProfile.js'
import { createAttachmentMessage, getQueuedCommandAttachments } from '../../utils/attachments.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
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

test('lean honors a skill selection the user sends while the turn is running, but not one from a system source', async () => {
  setAgentProfile('lean')
  const midTurn = async (command: Partial<QueuedCommand>) => {
    const [attachment] = await getQueuedCommandAttachments([{
      mode: 'prompt', value: 'Use the Skill tool with skill: "fixture-skill" for this request.', ...command,
    } as QueuedCommand])
    return {
      messages: [
        createUserMessage({ content: 'Fix the failing test' }),
        createAssistantMessage({ content: [{ type: 'tool_use', id: 'slow', name: 'Bash', input: { command: 'sleep 3' } }] }),
        createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'slow', content: 'slept' }] }),
        createAttachmentMessage(attachment!),
      ],
      getAppState() { throw new Error('must not discover commands') },
    } as unknown as ToolUseContext
  }
  // An accepted request continues to the local skill registry, whose availability checks need a credential.
  const savedKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'fixture-skill-tool-key'
  try {
    const human = await SkillTool.validateInput!({ skill: 'fixture-skill' }, await midTurn({}))
    expect(human.result ? undefined : human.errorCode).not.toBe(7)
    const notification = await SkillTool.validateInput!({ skill: 'fixture-skill' }, await midTurn({ mode: 'task-notification' }))
    expect(notification.result ? undefined : notification.errorCode).toBe(7)
    const peer = await SkillTool.validateInput!({ skill: 'fixture-skill' }, await midTurn({ origin: { kind: 'channel', server: 'session-collaboration' } }))
    expect(peer.result ? undefined : peer.errorCode).toBe(7)
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
  }
})
