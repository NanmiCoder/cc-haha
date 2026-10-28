import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import * as commands from '../../commands.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import * as localAgentTask from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import { setAgentProfile } from '../../utils/agentProfile.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import { SkillTool } from '../SkillTool/SkillTool.js'
import { SendMessageTool } from '../SendMessageTool/SendMessageTool.js'
import { AgentTool } from './AgentTool.js'
import * as agentRunner from './runAgent.js'
import * as agentToolUtils from './agentToolUtils.js'
import { resumeAgentBackground } from './resumeAgent.js'

const realRunAgent = agentRunner.runAgent
const allow = (async () => ({ behavior: 'allow' })) as never
const skill = 'fixture-review'
const agentId = asAgentId('a0123456789abcdef')
const sourceMessage = createAssistantMessage({ content: 'Delegating inspection.' })
type Invocation = Parameters<typeof agentRunner.runAgent>[0]

beforeEach(() => {
  setAgentProfile('lean')
  spyOn(commands, 'getCommands').mockResolvedValue([{ name: skill, type: 'prompt', source: 'project' }] as never)
})
afterEach(() => { mock.restore(); setAgentProfile('standard') })

function parentContext(humanPrompt: string): ToolUseContext {
  let state = getDefaultAppState()
  return {
    options: {
      commands: [], mainLoopModel: 'mock-model', tools: [], mcpClients: [], mcpResources: {},
      isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state, setAppState: update => { state = update(state) },
    setResponseLength: () => {}, messages: [createUserMessage({ content: humanPrompt })],
    toolUseId: 'skill-selection-fixture',
  } as unknown as ToolUseContext
}

async function childContext(invocation: Invocation) {
  let child: ToolUseContext | undefined
  const captured = new Error('Captured before provider access')
  const stream = realRunAgent({
    ...invocation, override: { ...invocation.override, userContext: {}, systemContext: {} },
    availableTools: [SkillTool],
    onCacheSafeParams: params => { child = params.toolUseContext; throw captured },
  })
  await expect(stream.next()).rejects.toBe(captured)
  expect(child!.options.tools.map(tool => tool.name)).toContain('Skill')
  return child!
}

async function spawnedChild(parent: ToolUseContext, prompt: string) {
  let invocation: Invocation | undefined
  spyOn(agentRunner, 'runAgent').mockImplementation(async function* (params) {
    invocation = params
    yield createAssistantMessage({ content: 'Inspected.' })
  })
  await AgentTool.call({ description: 'Inspect', prompt, subagent_type: 'general-purpose' }, parent, allow, sourceMessage)
  return childContext(invocation!)
}

async function resumedChild(parent: ToolUseContext, prompt: string, fromHuman = false) {
  // Old transcripts predate provenance tagging and may contain a model-written skill reference.
  spyOn(sessionStorage, 'getAgentTranscript').mockResolvedValue({
    messages: [createUserMessage({ content: `Use $${skill} to inspect.` }), createAssistantMessage({ content: 'Inspected.' })],
    contentReplacements: [],
  })
  spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({ agentType: 'general-purpose' })
  spyOn(localAgentTask, 'registerAsyncAgent').mockReturnValue({ agentId, abortController: new AbortController() } as never)
  let lifecycle: Parameters<typeof agentToolUtils.runAsyncAgentLifecycle>[0] | undefined
  spyOn(agentToolUtils, 'runAsyncAgentLifecycle').mockImplementation(async params => { lifecycle = params })
  const runner = spyOn(agentRunner, 'runAgent').mockImplementation(async function* () {})
  if (fromHuman) await resumeAgentBackground({ agentId, prompt, toolUseContext: parent, canUseTool: allow })
  else expect((await SendMessageTool.call({ to: agentId, message: prompt }, parent, allow, sourceMessage)).data.success).toBe(true)
  lifecycle!.makeStream(undefined)
  return childContext(runner.mock.calls[0]![0])
}

test('a model-written skill reference cannot select a skill for a new lean child', async () => {
  const child = await spawnedChild(parentContext('Inspect the parser.'), `Use $${skill} to inspect.`)
  expect(await SkillTool.validateInput!({ skill }, child)).toMatchObject({ result: false, errorCode: 7 })
  await expect(SkillTool.call({ skill }, child, allow, sourceMessage)).rejects.toThrow('explicit user skill selection')
})

test('a user-selected skill stays available to a child whose delegated prompt omits its name', async () => {
  const child = await spawnedChild(parentContext(`Use $${skill} to inspect the parser.`), 'Inspect this module.')
  expect(await SkillTool.validateInput!({ skill }, child)).toEqual({ result: true })
})

test('a model-written follow-up and old unmarked transcript cannot select a skill', async () => {
  const child = await resumedChild(parentContext('Inspect another module.'), `Continue using $${skill}.`)
  expect(await SkillTool.validateInput!({ skill }, child)).toMatchObject({ result: false, errorCode: 7 })
})

test('resuming on a new user request does not reuse the previous request skill selection', async () => {
  const parent = parentContext(`Use $${skill} to inspect the parser.`)
  parent.messages.push(createUserMessage({ content: 'Now inspect another module.' }))
  const child = await resumedChild(parent, 'Continue inspection.')
  expect(await SkillTool.validateInput!({ skill }, child)).toMatchObject({ result: false, errorCode: 7 })
})

test('an actual human SDK follow-up can explicitly select a skill', async () => {
  const child = await resumedChild(parentContext('Inspect the parser.'), `Continue using $${skill}.`, true)
  expect(await SkillTool.validateInput!({ skill }, child)).toEqual({ result: true })
})
