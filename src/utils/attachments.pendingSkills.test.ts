import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as commands from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import * as tasks from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../types/ids.js'
import { getAgentProfile, setAgentProfile } from './agentProfile.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import { createAssistantMessage, createUserMessage } from './messages.js'
import { createAttachmentMessage, getAgentPendingMessageAttachments } from './attachments.js'
import { runAgent } from '../tools/AgentTool/runAgent.js'
import { GENERAL_PURPOSE_AGENT } from '../tools/AgentTool/built-in/generalPurposeAgent.js'
import { getSkillSelectionMessages, isExplicitSkillRequest } from '../tools/SkillTool/explicitSkillRequest.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import { SendMessageTool } from '../tools/SendMessageTool/SendMessageTool.js'

const allow = (async () => ({ behavior: 'allow' })) as never
const originalProfile = getAgentProfile()
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  mock.restore()
  setAgentProfile(originalProfile)
})

async function runningWorker(initialPrompt: string) {
  setAgentProfile('lean')
  spyOn(commands, 'getCommands').mockResolvedValue([{ name: 'fixture-review', type: 'prompt', source: 'project' }] as never)
  let state = getDefaultAppState()
  const parent = {
    options: {
      commands: [], mainLoopModel: 'mock-model', tools: [], mcpClients: [], mcpResources: {},
      isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state, setAppState: update => { state = update(state) },
    setResponseLength: () => {}, messages: [createUserMessage({ content: initialPrompt })],
    toolUseId: 'running-selection-fixture',
  } as unknown as ToolUseContext
  const agentId = asAgentId('a0123456789abcdef')
  const task = tasks.registerAsyncAgent({ agentId, description: 'Fixture', prompt: 'Perform task A.', selectedAgent: GENERAL_PURPOSE_AGENT, setAppState: parent.setAppState })
  cleanups.push(() => task.unregisterCleanup?.())
  let child: ToolUseContext | undefined
  const capture = new Error('Captured before provider access')
  const stream = runAgent({
    agentDefinition: GENERAL_PURPOSE_AGENT,
    promptMessages: [createUserMessage({ content: 'Perform task A.', origin: { kind: 'coordinator' } })],
    toolUseContext: parent, canUseTool: allow, isAsync: true, querySource: 'agent:builtin:general-purpose',
    availableTools: [SkillTool], override: { agentId, abortController: task.abortController, userContext: {}, systemContext: {} },
    onCacheSafeParams: params => { child = params.toolUseContext; throw capture },
  })
  await expect(stream.next()).rejects.toBe(capture)
  // query.ts copies the context between tool rounds. Both copies must observe
  // a new selection only once this worker consumes its queued instructions.
  const queryContext = { ...child! }
  const canSelect = async () => (await SkillTool.validateInput!({ skill: 'fixture-review' }, child!)).result
  const send = (message: string) => SendMessageTool.call({ to: agentId, message }, parent, allow, createAssistantMessage({ content: 'Dispatching follow-up.' }))
  const consume = () => {
    const attachments = getAgentPendingMessageAttachments(queryContext)
    queryContext.messages.push(...attachments.map(createAttachmentMessage))
    return attachments
  }
  return { parent, child: child!, queryContext, agentId, canSelect, send, consume }
}

test.each([false, true])('a consumed follow-up replaces the original selection (initial selection: %s)', async initialSelected => {
  const worker = await runningWorker(initialSelected ? 'Use $fixture-review for task A.' : 'Perform task A.')
  expect(await worker.canSelect()).toBe(initialSelected)
  worker.parent.messages.push(createUserMessage({ content: initialSelected ? 'Now perform task B.' : 'Use $fixture-review for new task B.' }))
  expect((await worker.send('Now perform task B.')).data.message).toContain('Message queued')
  expect(await worker.canSelect()).toBe(initialSelected)
  expect(worker.consume()).toMatchObject([{ type: 'queued_command', prompt: 'Now perform task B.' }])
  expect(await worker.canSelect()).toBe(!initialSelected)
  expect(JSON.stringify(worker.queryContext.messages)).not.toContain('$fixture-review')
  if (initialSelected) {
    await expect(SkillTool.call({ skill: 'fixture-review' }, worker.child, allow, createAssistantMessage({ content: 'Inspect.' }))).rejects.toThrow('explicit user skill selection')
  }
})

test('a new parent request alone does not revoke a running worker selection', async () => {
  const worker = await runningWorker('Use $fixture-review for task A.')
  worker.parent.messages.push(createUserMessage({ content: 'Discuss a separate task.' }))
  expect(worker.consume()).toEqual([])
  expect(await worker.canSelect()).toBe(true)
})

test('model follow-up text never authorizes a skill', async () => {
  const worker = await runningWorker('Perform task A.')
  await worker.send('Use $fixture-review for task B.')
  expect(worker.consume()).toMatchObject([{ prompt: 'Use $fixture-review for task B.' }])
  expect(await worker.canSelect()).toBe(false)
})

test('the latest queued instruction selects for the current request and retains its own metadata', async () => {
  const worker = await runningWorker('Perform task A.')
  worker.parent.messages.push(createUserMessage({ content: 'Use $fixture-review for task B.' }))
  await worker.send('Continue.')
  worker.parent.messages.push(createUserMessage({ content: 'Now perform task C.' }))
  await worker.send('Continue.')
  worker.parent.messages.push(createUserMessage({ content: 'Unrelated later parent request with $fixture-review.' }))
  expect(worker.consume().map(attachment => (attachment as { prompt: string }).prompt)).toEqual(['Continue.', 'Continue.'])
  expect(await worker.canSelect()).toBe(false)
})

test('direct human follow-ups select skills while legacy string-only messages do not', async () => {
  const worker = await runningWorker('Perform task A.')
  const human = createUserMessage({ content: 'Use $fixture-review.', origin: { kind: 'human' } })
  tasks.queuePendingMessage(worker.agentId, 'Use $fixture-review.', worker.parent.setAppState, [human])
  worker.consume()
  expect(await worker.canSelect()).toBe(true)
  tasks.queuePendingMessage(worker.agentId, 'Use $fixture-review.', worker.parent.setAppState)
  worker.consume()
  expect(await worker.canSelect()).toBe(false)
})

test('standard pending messages preserve their original prompt and do not change skill selection state', async () => {
  const worker = await runningWorker('Use $fixture-review for task A.')
  setAgentProfile('standard')
  tasks.queuePendingMessage(worker.agentId, 'Continue.', worker.parent.setAppState, [])
  expect(worker.consume()).toMatchObject([{ prompt: 'Continue.', origin: { kind: 'coordinator' }, isMeta: true }])
  expect(isExplicitSkillRequest(getSkillSelectionMessages(worker.child), 'fixture-review')).toBe(true)
})
